# Tidysum guide

The full reference: every command, detector and rule, and how Tidysum runs. Start with the
[README](../README.md) for what Tidysum is and how to set it up, and read
[DISCLAIMER.md](../DISCLAIMER.md) before relying on anything here.

## The demo

`tidysum demo` (`pnpm demo` in a checkout) starts a Postgres of its own in `~/.tidysum/demo`
(Tidysum's own Postgres, below), stopped again when the demo ends: it resets that database, makes up a household
(`src/demo/household.ts`: two years of checking, savings, two cards, a brokerage and a 401(k),
ending today), links and syncs it through `DemoPlaid` instead of Plaid, records a 401(k) plan, an
IRA year, a policy and `docs/plan.example.md`, runs every detector, drafts the actions and serves
the page on http://127.0.0.1:8090 with a "Demo" bar. It prints an MCP address and a one-run token
for your agent.

The demo never reads `.env` or `DATABASE_URL`. It only resets a database named `tidysum_demo`, and
refuses when that Postgres server holds any other database or Tidysum's tables, so it can't reach
real data. Linking or removing institutions is refused on the demo page.
`TIDYSUM_DEMO_DATABASE_URL` (for example docker-compose.yml's `demo-db`) and `TIDYSUM_DEMO_PORT`
change where it runs.

`tidysum demo --static <dir>` writes the online demo instead of serving: the same page with a
snapshot of every API response it reads, and a small loader (`static.js`) that answers from the
snapshot and refuses changes. `.github/workflows/pages.yml` builds the website from `site/`,
`docs/assets/` and that snapshot, on every push to main and weekly so the demo's dates stay
current, and deploys it to https://lucidity-finance.github.io/tidysum/.

## Linking real accounts

`pnpm tidysum serve` runs the admin page, Plaid's webhook endpoint and the scheduled sync in one
process. Open it (on the default loopback `HOST` there is no sign-in; bound to any other address
it asks for any username and `TIDYSUM_ADMIN_TOKEN` as the password), and click
**Link institutions**. One Link session can add several banks and brokerages in a row (Plaid's
Multi-Item Link), so Plaid's phone code is entered once per session rather than once per bank;
Tidysum registers the user with Plaid (`/user/create`) the first time and falls back to one
institution per session if Plaid refuses. Items that need re-authentication show a **Reconnect**
button, which opens Plaid Link in update mode. Link asks Plaid for 730 days of history.

Webhooks need `TIDYSUM_PUBLIC_URL` (https). Every webhook must carry a valid `Plaid-Verification`
JWT (ES256, body hash, at most 5 minutes old) or it is rejected with 401.

## Outside the US

`tidysum user country <code>` sets where the user lives (US by default): the currency Tidysum
counts in, which countries Plaid Link offers banks from, which catalog products and money-style
funds they see, and whether US-only checks run. Canada works with Plaid's free plan; UK and EU banks
connect through Enable Banking (`src/enableBanking/`, `ENABLE_BANKING_*` in `.env`), or through
Plaid with `PLAID_EUROPE=true` for a Plaid team with European access. Funds and the cash
yardstick follow the country too: UCITS ETFs and SONIA in the UK, Xetra-listed UCITS ETFs and €STR
in the EU. Fee swaps stay inside the owner's own market (a UK owner is offered ISF for VUKE, never a
US ETF), and ISAs, SIPPs, TFSAs and RRSPs count as tax-sheltered.
See [decision 0011](decisions/0011-countries.md) for what each country still needs.

## SimpleFIN Bridge

A second way to connect US accounts, with no keys to set up ([decision 0013](decisions/0013-simplefin.md),
`src/simplefin/`). The person pastes a SimpleFIN setup token on the Connections page or runs
`tidysum simplefin -`; Tidysum claims an access URL (stored encrypted in `item_secret`), makes one
item per bank (`item.source = 'simplefin'`), and syncs through the same gateway as Plaid. Requests
are shared between the banks of one access URL and capped at 20 a day. Account kinds and categories
are inferred (`src/simplefin/categories.ts`); there are no liabilities.

## Institutions Plaid can't reach

```sh
pnpm tidysum import-csv apple-card.csv --institution Apple --account "Apple Card" \
  --type credit --date-col "Transaction Date" --amount-col "Amount (USD)"
```

Re-importing an overlapping export only adds the new rows. Tidysum stores amounts as positive =
money out, so pass `--flip-sign` for exports where purchases are negative (most bank CSVs).

## Agents (MCP)

Tidysum's MCP server gives agents read-only tools: `list_accounts`, `query_transactions`,
`get_holdings`, `get_liabilities`, `cash_flow_summary`, `net_worth_history`,
`compare_products`, `compare_cards`, `best_card_for_purchase`, `get_allocation`,
`get_research_candidates`, `fund_fees`, `card_terms`, `benchmark_rates` and `list_stale_facts`
(see [Where the numbers come from](#where-the-numbers-come-from)). Every query
runs as the `tidysum_agent` role in a read-only session, so agents never see Plaid tokens or
cursors and cannot write. Money comes back as decimal strings.

Locally, over stdio. For Claude Code, the owner runs one command in the repo, once:

```sh
pnpm tidysum agent setup        # --dry-run shows what it would change
```

It adds the MCP server for your user (`claude mcp add --scope user tidysum -- pnpm -s --dir
<repo> tidysum mcp`), links the [tidysum-actions skill](../skills/tidysum-actions/SKILL.md), and adds
two permission rules to `~/.claude/settings.json`: `mcp__tidysum` (Tidysum's MCP tools) and
`Bash(pnpm -C <repo> -s tidysum:*)` (its command line). Without them, Claude Code's permission
checks stop the agent at each step, and an agent can't grant itself permissions, so the owner
runs this themselves. Neither can move money: only the owner approves actions, on the Actions
page, and the owner presses Submit on every trade. Agents run Tidysum commands in exactly that form,
`pnpm -C <repo> -s tidysum <command>`. Other MCP clients: run `pnpm -s --dir <repo> tidysum mcp`
as a stdio server.

When `TIDYSUM_MCP_TOKEN` is set, `tidysum serve` also exposes the same tools at `/mcp`
(Streamable HTTP, stateless) behind `Authorization: Bearer <TIDYSUM_MCP_TOKEN>`. That token is
separate from the admin password and only opens `/mcp`.

## Your agent carries out approved actions

Tidysum has no agent of its own ([decision 0005](decisions/0005-actions.md)). Once the owner
approves an action on the Actions page, their own agent can carry it out with its own browser
tools: `start_action` (returns the steps, the sites involved and the rules), `report_step` (a
step done, or `your_turn` when only the owner can do it: identity checks, codes, signatures),
`finish_action`, `stop_action`, and `pause_action` for a step that can only go on later (a
waitlist invite, a paycheck that has to land): the action waits under Scheduled until the day
it names, with what happens then as its headline. Only an approved action can be started. Trades, the
new-money action and 401(k) fund exchanges are the agent's to prepare, never to place: it fills
in the order on the broker's or plan's site up to the final review screen and hands over with
`your_turn` ("Review the order and press Submit"), and the owner presses Submit. 401(k)
contribution elections are the agent's to do. An investing action with no steps for an agent is
refused; it waits for Tidysum's own trading (Phase 4). Reports are append-only audit events
written as `tidysum_proposer`, and the Actions page shows where the agent is and what it needs.
A finished action is marked done on the next tick, and a later sync confirms it.

The workflow and rules ship as a skill, [skills/tidysum-actions](../skills/tidysum-actions/SKILL.md),
and as the MCP prompt `carry_out_action` for agents without skills. For Claude Code,
`pnpm tidysum agent setup` links it (a link, not a copy, so a pull updates it).

Then ask it to "carry out my approved Tidysum actions".

## Actions with a day

Some fixes have a date ([decision 0006](decisions/0006-scheduled-actions.md)): next year's
401(k) percent can only be set after this year's last payday, and a paystub can only be checked
once it's out. An action can carry `not_before` (the first day it may be carried out) and `due_by`
(the last day it still does its job). The owner approves it on the Actions page whenever they
like, ahead of time included; an approved one waits under **Scheduled** until its day, then moves
to In progress, and `start_action` refuses it before then. Detectors set the days when they know
them (`retirement_rate` does for next year's percent). Agents add one with the MCP tool
`schedule_action`, typically a follow-up check after a change (`follows_up` names the action it
checks, and finishing the check confirms that action: no sync can see a 401(k) election); the
owner adds one with
`pnpm tidysum action schedule <file>` (see `scheduled-action.example.json`). `pnpm tidysum
actions` lists the queue with the days.

An action can also wait for calm markets ([decision 0008](decisions/0008-calm-markets.md)):
`wait_for: "calm_markets"`, for a sale whose money goes straight back into the market. While
`tidysum serve` runs it records past VIX closes from FRED (`VIXCLS`) at most every twelve hours
and today's level from Cboe's delayed quote every hour, into `market_reading`. Markets are calm
when the last five closes are each at or below 20, none of the last fifteen is above 25, and the
newest is at most four days old. Until then an approved one waits under **Scheduled**; the first
calm hour it turns due, the owner is notified, and an agent action goes to the owner's agent. If
markets turn jumpy before it's done, it waits again and the owner is told. The brokerage-window
move waits this way.

While `serve` runs it checks the days every hour (`pnpm tidysum due` runs the check once): it notes
in the audit log, and tells the owner with a notification (`TIDYSUM_NOTIFY`), when an action comes
due, the day before its last day, and when it's past due. If `TIDYSUM_AGENT_COMMAND` is set, it
also starts the owner's own agent on an approved action the day it comes due (within
`TIDYSUM_AGENT_HOURS`, at most once a day and three times in all), passing the action's id and a
one-line request; the agent then works it like any other approved action and hands over for
sign-ins and codes.

## Workplace retirement plans

Plaid shows a 401(k)'s holdings but not the elections behind them. Record what the plan's site
shows with `pnpm tidysum workplace set <account_id> <file>` (`workplace.example.json` is the
shape: pay, contribution percents and year-to-date total, the match, where each paycheck is
invested, and every fund in the plan with its yearly cost). Keep the real file as `workplace.json`,
which git ignores. With investing enabled, three detectors price it:

- **retirement_rate:** contributions that fall short of the year's IRS limit (pre-tax money saves
  tax only in its own year), or that reach it before the last paycheck (later paychecks get no
  match unless the plan trues up). In the last two paychecks of a year it looks at next year,
  and that action waits until the day after this year's last payday. Paydays are the usual ones
  (the 15th and the last day, or the last day, moved back to the Friday before a weekend) unless
  `pay.pay_dates` lists them; pay every one or two weeks needs `pay.last_pay_date`, and
  `pay.cutoff_days` is how far ahead of a payday payroll needs a change.
- **fund_fee:** a plan fund that costs more than a faithful copy of it in the plan's own index
  funds (decision 0007). The copy is built from what the fund actually holds: its lineup `mix`,
  by sleeve (`us_stocks.large`, `us_stocks.small_mid`, `intl_stocks`, `bonds`), and for a
  target-date or other several-sleeve fund the fact sheet it came from (`mix_source`) and its date
  (`mix_as_of`, re-read after about a year). Each sleeve goes to the cheapest plan fund holding
  exactly that sleeve. No recorded mix means no swap and a note asking for the fact sheet; a
  sleeve the plan has no fund for means no swap either. The action shows the fund's holdings and
  the copy side by side, then swaps it inside the plan.
- **brokerage_window:** money in the plan's brokerage window (Schwab PCRA and the like, linked as
  its own account and paired with the plan's lump by `src/portfolio/overlap.ts`). Each fund in it
  is copied the same way, from its `mix` in `catalog/securities.json` (an S&P 500 fund is
  `us_stocks.large`); a fund the plan can't copy (a real estate fund, with no real estate fund in
  the plan) stays in the window, unless the owner lists its ticker in `window_also_sell`: then it
  is sold too and its money goes in the same split as the rest. It's priced as what the moved funds cost (`expense_ratio` in the
  catalog) over their copy; the bigger reason is nothing to trade by hand. The action sells the
  funds that can be copied and puts the cash back into the plan's index funds, tax-free inside
  the plan. While the plan still reports money in its window but no linked account matches it
  (the two are priced on different days and drift apart in a fast market), the finding is left
  as it is: only the window's funds leaving counts as the move being made.

Plaid sometimes reports a ticker-less plan fund under an unrelated security (a 401(k)'s large-cap
index fund showing up as a small mining stock with its ticker). List each one in
`holding_names` as `{ "reported": "<name or ticker Plaid shows>", "fund": "<lineup name>" }`,
from what the plan's own site shows; Tidysum then reads that holding as the lineup fund everywhere.

The new-money action also says how each paycheck should be invested in the plan, in its cheapest
fund per bucket. `allocation.new_money_max_share` in the policy caps how much of each
contribution one bucket takes while the mix catches up (once on target, contributions follow the
targets uncapped). A bucket with `taxable_new_money: false` (asset location, such as bonds) is left
out of the new-money split, which is what a taxable brokerage buys; the accounts that hold it, such
as a 401(k) mirroring a target-date fund, fill it. An owner who wants paychecks to match one
of the plan's funds instead sets `paychecks_mirror` to its name: paychecks then copy its recorded
mix sleeve by sleeve (decision 0007), and the window's paycheck share goes there too, as does
the money moved out of the window (decision 0008). Limits live in `src/retirement/limits.ts`.

## IRAs

With investing enabled, **roth_ira** prices unused Roth IRA room for each tax year still open
(the year itself, and last year until April 15): the tax its growth would pay in a taxable
account, at an assumed 7% a year and the federal capital gains rate. Above the Roth IRA income
limit (estimated from the workplace plan's pay, or recorded) the action is a backdoor Roth:
contribute to a traditional IRA, convert it to Roth, and keep no pre-tax IRA money on December 31
(pre-tax money found in a traditional, SEP or SIMPLE IRA is rolled into the 401(k) first). The
owner's agent carries it out. Plaid can't say which tax year a contribution counts for, so a
finished IRA action records itself in `ira_year`; record other contributions with
`pnpm tidysum ira set <file>` (`ira.example.json` is the shape).

Some brokerages match IRA contributions with their own money (`src/retirement/iraMatch.ts`, with
the terms' source and the day they were checked). When the IRA the contribution lands in is at one,
the finding adds the match to its cost, at the better of the free rate and a paid membership's
rate less a year of the membership. In a backdoor Roth the match arrives in the traditional IRA
as earnings, so the action waits for it and converts it too, and its tax is counted. Robinhood:
1% for everyone, 3% with Gold ($50 a year or $5 a month, kept a year after the first Gold
match), only on contributions from a linked bank, credited within about a week, and charged back
if the money leaves Robinhood within 5 years. A membership the owner already pays for
(`memberships` in the IRA year, like `["Robinhood Gold"]`) isn't counted against the match, and
the action doesn't ask to turn it on.

## Your plan

The policy is the numbers; the plan is the why. Write your plan for your money in Markdown (what
it is for, goals, target mix, where each dollar goes, the rules you keep) and load it with
`pnpm tidysum plan set <file>`. [plan.example.md](plan.example.md) is a starting point: copy it to
`plan.md` in the repo root, which git ignores, and make it yours. Set `TIDYSUM_PLAN_FILE=plan.md` in
`.env` and `deploy/macos-setup.sh` reloads it on every deploy, so the file stays the source of
truth. The admin page shows it under
Plan, and agents read it with `get_plan` and keep their advice inside it.
`pnpm tidysum plan show` prints the stored plan.

## Research sleeve (investment-miner)

A small, capped slice of the portfolio for picks from investment-miner, a separate research tool
the owner runs (Python, SQLite), kept apart from the core allocation. Add it to the policy:

```json
"research_sleeve": { "cap": "0.05", "tickers": ["TICKER"] }
```

`cap` is the most of investable assets (every investment account, plus holdings entered by hand)
the sleeve may hold, at most 0.25. `tickers` are the positions held as sleeve picks: they count
toward the cap and are left out of the core buckets, and a ticker can't be in both. Investment
advice, so all of it only runs for users with investing enabled.

Tidysum never reads the miner's database. Set `TIDYSUM_MINER_DIR` to its directory and
`tidysum research import` (and `serve`, every `TIDYSUM_MINER_INTERVAL_HOURS`, default 1) reads its
runs through its own read-only CLI: `list-runs`, then `export --run <id> --format json` for each
watchlist's newest current run. Only export `schema_version: 2` is accepted. A run is current when
it **completed**, or when it is **partial** but fetched at least 90% of its sources (the export's
`run.coverage.ratio`): the miner marks a run partial when even a few of its hundreds of price
fetches fail, which is most institutional runs. Thinner partial runs and failed, running or legacy
runs never are; the next older usable run is shown instead, and the page says why. Each run's id,
as-of time, status, share fetched, scoring version and limitations are kept with its top 50
candidates and a short evidence summary for each. Institutional lists also show their biggest
drops: of those top 50 conviction picks, the ones furthest below their 52-week high.

**Scan now.** The Investments page's _Scan now_ button (and `tidysum research scan`) asks the
miner's own API (`TIDYSUM_MINER_URL`, default `http://127.0.0.1:8000`) to scan every
institutional watchlist, signing in with the `AUTH_PASSWORD` in the miner's `.env`. The miner runs
one scan per product at a time, so a press during a scheduled scan just shows that scan's
progress. When no scan is left running, Tidysum imports the new runs. Scans take about 15
minutes; `tidysum research scan assets` scans the asset watchlist instead.

`tidysum research`, the MCP tool `get_research_candidates` and the Investments page show the
sleeve against its cap and the ranked candidates, with the run's age and a warning when the newest
run is over two weeks old. A ticker the owner already holds shows once, tagged. A miner score is
research evidence, not a target weight or an instruction to trade, and `check_policy` and the
tool both say so. Proposals may buy into the sleeve only with new money (a proposal that also
sells is blocked) and only up to the cap, counting the buy itself; a buy of a ticker the miner ranks
and no bucket lists counts as a sleeve buy.

On a Mac, `deploy/macos-setup.sh` also runs the miner's API server on 127.0.0.1:8000 as a launchd
agent when `TIDYSUM_MINER_DIR` is set. Its built-in scheduler runs the scans in the miner's
`config.yaml` (weekdays after the US close, UTC); only run one scheduler per miner database, so
stop the agent before running the miner's own `just serve`. The first time, it backs the miner's
database up to `~/Library/Application Support/tidysum/investment-miner-backups/`, since the
miner upgrades an older database on start.

## Policy and proposals

Your rules are a policy: cash buffer, card payoff, extra debt payments, target allocation,
Robinhood agentic funding, and optional hard caps. Write one as JSON (start from
`cp policy.example.json policy.json`, git-ignored) and load it with `pnpm tidysum policy set
policy.json`. Policies are stored per user in the database; each distinct content gets a version
id (sha256), the latest one set is active, and every proposal records the version it was checked
against.

```sh
pnpm tidysum policy show  # the active policy
pnpm tidysum check        # deterministic checks: cash vs buffer, card statements, allocation drift
pnpm tidysum proposals    # what agents have proposed
```

### Money styles

A money style fills the policy from a well-known way of running money (decision 0009): its cash
buffer, card and debt rules and target mix replace yours where it has a view, and your accounts,
limits, research sleeve and asset location stay. The policy records which style it came from
(`style`), and the Plan page and `get_policy` say what you changed since.

```sh
pnpm tidysum policy styles [--age 35]                 # every style and what it would change
pnpm tidysum policy style adviser_standard --age 35 --dry-run
pnpm tidysum policy style debt_free_first             # fill the policy from it
```

Styles use three policy rules that hand-written policies can use too: `debt.extra_payments:
"smallest_balance"` (the debt snowball, mortgages left out), `cash.buffer_while_in_debt` (a
smaller buffer while there is consumer debt, so spare cash goes to it), and
`cards.avoid_credit_cards` (no suggestions to open cards or move bills onto them).

Agents get `get_policy`, `check_policy`, `list_styles`, `list_proposals` and `create_proposal` over
MCP. Only the owner switches styles.
`create_proposal` and the reports on approved actions above are the only writes any agent can
do. They run as `tidysum_proposer`, a role that can insert proposals and audit events and
nothing else, and the policy engine stores a proposal
that breaks a limit (cash buffer, caps, overpaying a card) as `blocked` with the reasons. The
admin page shows each proposal on the finding it fixes (by `finding_key`), where the owner can
approve or dismiss it. Approving checks the proposal again against the active policy and the
latest data, records `approved` with that evidence, and executes nothing. `audit_event` is
append-only, enforced by a trigger, and has no foreign keys, so it outlives what it logs.
Execution is Phase 4, and must check once more before moving anything.

Leaving is one step (decision 0002, principle 9). `tidysum item remove <item_id>`, or Remove on the
admin page, revokes a connection at Plaid and deletes its accounts and everything synced from
them, along with proposals that named those accounts; findings that relied on them are
withdrawn, never counted as fixed. `tidysum user delete <user_id> --yes` does that for every
connection and then deletes the user. Audit events stay for at least 7 years.

Each proposal also records its category (`cash`, `card`, `debt` or `securities`), the
`check_policy` finding it fixes and what it should save or earn per year, and its audit event
keeps the exact data it was checked against. Allocation checks and trade proposals are
investment advice, so they only run for users with `investing_enabled` (the operator; `tidysum
user add <name> --investing` for someone managing their own money).

## Better accounts

`pnpm tidysum products` (and **Cash accounts** on the admin page, and the
`compare_products` MCP tool) compares every checking, savings, money market and cash management
account with the products in `catalog/deposit-products.json` and says how much not switching
costs per year.

- **What you earn now is observed, not assumed.** Interest is the account's own
  `INCOME_INTEREST_EARNED` credits over the last 365 days; fees are its maintenance, overdraft
  and NSF fees. Less history is annualized. The balance is the average of the last 90 days of
  daily balances, rebuilt from transactions (see below) when they cover all 90 days, otherwise
  from the snapshots synced so far. One exception: an account Tidysum recognizes as a catalog
  product (same bank, same kind) earns at least that product's published rate, so a new account
  isn't taken to pay nothing before its first interest posts.
- **The bank you picked stays picked.** When you pick a product for an account's spare cash
  (SoFi, because it takes your paycheck, say), an account you hold at that product counts at its
  direct-deposit rate and is never told to move somewhere else.
- **What you could earn comes from the catalog.** Each product has its APY tiers, any condition
  for a higher rate (direct deposit, say), fees, the provider's page as `source_url`, the bank's
  printed `rates_as_of` date and the `verified_on` date someone last checked that page. A rate
  more than 30 days past `verified_on` is flagged stale. Promotional boosts and sign-up bonuses
  are left out.
- **Updating rates:** your agent does it (see [Where the numbers come from](#where-the-numbers-come-from)),
  or edit the file: open each `source_url`, change the numbers and both dates, and commit. The
  catalog is read on every request, so `tidysum serve` picks it up without a restart.
  `TIDYSUM_PRODUCTS_FILE` points at a different file.

The headline is the best gain per account summed, with conditions met; a second total uses only
rates that need no conditions. Figures are before tax.

## What idle cash has already cost

`pnpm tidysum cash-history` (also `idle_cash_history` over MCP and **What idle cash has cost you**
on the Cash page) looks back instead of forward: what the cash above your buffer lost, day by day,
over up to the last 730 days.

- **Balances are rebuilt, not fetched.** Plaid has no balance history, so the balance at the end
  of each day is the latest synced balance plus every posted transaction after that day. Balance
  snapshots synced earlier are compared with the rebuilt series, and a difference over $1 is
  flagged, since it means a transaction is missing. A snapshot may match the day before instead,
  because banks often add a deposit to the balance a day after its date.
- **Idle is above the buffer.** Each day, the total across the policy's cash accounts minus the
  policy's cash buffer. With no policy there is no buffer.
- **The benchmark is the catalog.** Every savings and cash management product in
  `catalog/deposit-products.json`, at today's rate with no conditions, compounded daily. Rates
  were higher in 2024 and 2025, so the loss further back errs low. Interest actually credited on
  the cash accounts is subtracted.

## Credit cards

`pnpm tidysum cards` (also `compare_cards` over MCP and **Credit cards** on the admin page) takes
the last 365 days of purchases from linked cards and bank accounts, works out what your cards
earn on them, and ranks every card in `catalog/credit-cards.json` you don't have by what it would
add per year after its annual fee. It also picks the best set of cards to add, one at a time
while each still pays for itself. `pnpm tidysum card-for --merchant "Whole Foods" --amount 80`
(`best_card_for_purchase` over MCP) says which of your cards to use; the category comes from your
past purchases at that merchant, or pass `--category`.

- Spending categories are Tidysum's own (dining, groceries) and map to each data source's codes
  under `codes`; today that is Plaid's personal finance categories, which read straight off
  synced transactions. Transfers, loan and card payments, income and bank
  fees are not spending. Rent, taxes and donations only count for cards with a rate for them.
- Points are valued at their cash or statement-credit value. Portal-only rates, rotating
  quarterly categories and welcome bonuses are left out. Caps are honoured.
- Linked cards are matched to the catalog by the name the bank reports. When that name is too
  generic, the card is assumed to pay 1% and flagged. Say which card it is with the picker on
  the admin page or `pnpm tidysum card-set <account_id> <card_id>`; it's stored per user in
  `card_assignment`, which agents can read but not change. `--card <account_id>=<card_id>` (or
  `cards` over MCP) overrides it for one run.
- Purchases on cards that aren't linked can't be seen, so link every card you use.
- When cards charged interest in the last year, the report says so first: interest on a carried
  balance outweighs any rewards.

Every product and card answer carries the same disclosure: Tidysum takes no referral or affiliate
money, and rankings use only what a product would gain you.

## Where the numbers come from

Every rate, fee and APR Tidysum shows comes from the provider itself or from US government data.
No comparison site, aggregator or referral feed is ever the source: those are paid when you open
an account, which bends what they list.

**Public data, fetched by itself.** `tidysum serve` fetches each source when it's due (`pnpm
tidysum facts refresh` does it now; `pnpm tidysum facts` says when each last arrived). All three
are free, need no key, and may be shipped with an open-source tool.

- **What funds charge:** the SEC's [prospectus risk/return data
  sets](https://www.sec.gov/data-research/sec-markets-data/mutual-fund-prospectus-riskreturn-summary-data-sets),
  every mutual fund's and ETF's fee table, monthly. The last 13 months cover about 26,000 share
  classes with tickers (a first fetch is about 200 MB; later ones a file a month). The fee is the
  one after waivers, with the filing as its source. Unit trusts such as SPY and QQQ don't file
  it. `fund_fees` (MCP) and `pnpm tidysum fund-fees` price each held fund per year;
  `get_holdings` carries each position's expense ratio; and a catalog fund without an
  `expense_ratio` gets the SEC's. The SEC asks every request to name who is asking: set
  `TIDYSUM_SEC_USER_AGENT` to your name and email, or requests name the project's contact.
- **Card fees and APRs:** the CFPB's [Terms of Credit Card Plans
  survey](https://www.consumerfinance.gov/data-research/credit-card-data/terms-credit-card-plans-survey/),
  twice a year, about 660 cards from 150+ issuers: annual fee, purchase APRs, foreign transaction
  fee. It has the kinds of rewards but not their rates, and it is several months old when
  published. `card_terms` (MCP) searches it for any card, in the catalog or not.
- **A yardstick for cash:** the 13-week Treasury bill's yield from the [Treasury's daily bill
  rates](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_bill_rates),
  the coupon-equivalent figure comparable to an APY. `benchmark_rates` (MCP) returns it.

**Catalog rates, kept current by your agent.** Bank APYs, card reward rates and brokerage terms
have no neutral free source, so they stay in the catalogs with the provider's page as
`source_url`. `list_stale_facts` (MCP) lists what to re-check: anything verified more than 30
days ago, and cards whose fees the CFPB's survey states differently. Your agent opens each page
itself and records what it found with `submit_fact_check`:

- `confirmed` (still right), `changed` (the new `apy`, `conditional_apy` or `monthly_fee`; a
  card's `annual_fee`, `foreign_transaction_fee` or `base_rate`) or `not_found`.
- The page must be on the provider's own site, and the agent quotes the sentence that states the
  numbers; Tidysum refuses a check whose quote doesn't contain each new value.
- Checks are stored in `fact_check` and laid over the catalog files wherever Tidysum uses them:
  `verified_on` moves to the day of the check and changed values replace the file's. A later edit
  to the file (a newer `verified_on`) wins. Product terms are public, so every user's
  recommendations use every check; row-level security records each as the agent's own user.

## Investments

`pnpm tidysum allocation` (also `get_allocation` over MCP and **Investments** on the admin page)
compares your holdings with the policy's target allocation and says where new money should go to
reach it, the way an adviser handles a client's contributions, without selling anything. It is in
percentages only: each bucket's share of the portfolio, how many points it is off target, and how
to split each new contribution. It never shows what anything is worth.

- **New money** goes only to the buckets under target, split so they reach their targets
  together: with new money worth n of today's portfolio, a bucket with target t and weight w gets
  t(1 + n) − w, where n = (their gap) / (1 − their targets). The split is in whole percents and
  says which fund to buy; `catch_up` is n, so "until about 38% more has gone in". Once nothing
  is under target, new money follows the targets. The report recomputes it on every sync, so the
  split shifts as markets move.
- **Holdings you enter by hand** cover what no data source reaches, such as Treasuries at
  TreasuryDirect. Each has a name, one asset class from the catalog and a value, per user, in
  `manual_holding`:

  ```sh
  pnpm tidysum manual set "TreasuryDirect" --class bonds --value 10000.00 [--as-of 2026-11-06]
  pnpm tidysum manual list            # names, classes and dates; values stay out
  pnpm tidysum manual remove "TreasuryDirect"
  ```

- **Holdings are put in buckets** by, in order: a ticker the bucket lists; what
  `catalog/securities.json` says the fund holds by asset class (a global ETF counts partly as US
  and partly as international stocks, from the issuer's country breakdown, with its source and
  date; a sleeve like `us_stocks.large` counts toward its class); a target-date fund by the year
  in its name, split along the catalog's glide path (plan funds like "The 2055 Retirement Fund"
  often have no ticker; an estimate for counting only, never for copying a fund, decision 0007);
  a cash equivalent; then a Plaid
  security type the bucket names. A bucket holds the
  asset classes in its name (`bonds_and_cash` holds bonds and cash) unless it lists
  `asset_classes`. Holdings that match no bucket are reported and left out of the percentages.
- **Money is counted once.** A 401(k) with a brokerage window (Schwab PCRA, Fidelity
  BrokerageLink) reports the window as one lump position, and the brokerage reports it again as
  its own account. A lump whose name says it's a brokerage window and whose value is within 3% of
  another investment account is left out, and that account's own funds are counted instead
  (`src/portfolio/overlap.ts`). The page says which account it counted once; `get_holdings` and
  `net_worth_history` leave the duplicate out too.
- **Selling to rebalance** is there for when you ask for it (`get_allocation`, the CLI), not on
  the page. **Moves** pair overweight buckets with underweight ones, largest gap first, once any bucket is
  outside `drift_band`. Each says which positions to sell, as a share of the position, from
  tax-advantaged accounts first, then losses before gains, smallest gain first, and what to buy
  in the same account: the first ticker the bucket lists that you already hold, else its first
  ticker, else the catalog's default fund for the class.
- It also shows how much is in single stocks and the largest holdings.
- **The admin page is calm on purpose**: where new money goes, then each bucket's share against
  its target, with no warning colours. It never names a position you hold, how much one is up or
  down, or anything to sell; `/api/allocation` leaves those fields out. The per-position detail is
  for `get_allocation` and the CLI.

Allocation is investment advice, so it only runs for users with `investing_enabled`. The Actions
page puts it to the owner as an action, with the split, when new money has somewhere to catch up.
`check_policy` reports the same drift, in points. Outside the drift band the drift is also a
ranked misallocation, `allocation_drift`, priced by risk (below).

## Brokerages and IRAs

Every investment account that isn't a workplace plan or its brokerage window gets three more
checks ([decision 0012](decisions/0012-brokerage-pricing.md)), with investing enabled:

- **holding_fee:** a fund that costs more than another fund holding the same thing. Only catalog
  funds with the same `tracks` count as the same thing (`sp500`: VOO, IVV, SPY ...; `nasdaq100`:
  QQQ, QQQM; `gold_bullion`: GLD, IAU, GLDM; `ftse_100`; `msci_world` ...), and only funds listed
  where you buy funds (UK-listed UCITS ETFs for a UK owner, ETFs rather than another family's
  mutual funds in the US). A theme or sector ETF that nothing else copies is never compared.
  In an IRA, ISA, SIPP, TFSA, RRSP or similar account the swap owes no tax; in a taxable account
  it is suggested below cost, or at a gain when the lower fee pays back the tax (15% federal
  long-term rate assumed) within two years. Otherwise the warning says to keep it and buy the
  cheaper fund with new money. No cost basis from the brokerage means no swap yet.
- **brokerage_cash:** cash sitting uninvested (Plaid's `CUR:USD`), priced as what the country's
  Treasury bill fund (SGOV; ZMMK, CSH2 or XEON elsewhere) pays at the cash yardstick, less its
  fee, over what the brokerage pays. Brokerage rates are in `brokerage_cash` in
  `catalog/securities.json` (Robinhood's rises with Robinhood Gold, which counts when the IRA facts
  list it under `memberships`). A money market fund used as the brokerage's cash (VMFXX, SPAXX)
  is a fund, not idle cash. The action invests the cash toward your target mix, keeping only
  what should stay cash in the Treasury bill fund.
- **allocation_drift:** a bucket outside the drift band, priced as the risk-adjusted return a mix
  you didn't choose gives up: ½·γ·dᵀΣd of what the buckets hold, with Σ from J.P. Morgan's
  long-run volatilities and correlations (`risk` in the catalog) and γ how much return your own
  target asks per unit of risk. It never predicts one class beating another, and the new-money
  action, which fixes it without selling, carries the price.

## Misallocations

`pnpm tidysum misallocations` (also `find_misallocations` over MCP and the top of the admin page)
runs every detector and lists what is costing you money, ranked by cost per year:

| Detector           | Category   | Finds                                                                                                                      |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `deposit_rate`     | cash       | a cash account earning less than the best catalog product would                                                            |
| `card_wallet`      | card       | each card worth adding, priced by what it adds on top of the ones before it                                                |
| `card_usage`       | card       | purchases paid from a bank account that would earn rewards on your best card                                               |
| `foreign_fees`     | card       | foreign transaction fees paid in the last year                                                                             |
| `card_statement`   | card       | a card statement due on a card that has charged interest (a year of its APR, or the interest charged, whichever is larger) |
| `extra_payment`    | debt       | spare cash above the buffer that could pay down the highest-APR debt                                                       |
| `holding_fee`      | securities | a brokerage or IRA fund that costs more than one holding the same index                                                    |
| `brokerage_cash`   | securities | uninvested brokerage cash earning less than a Treasury bill fund                                                           |
| `allocation_drift` | securities | a mix outside its drift band, priced as the risk you didn't choose                                                         |

Each finding has a stable `key`, a `category` (`cash`, `card`, `debt`, `securities`), the action
that fixes it, and the `inputs` it was priced from, including the sha256 of the catalog it used.
`not_covered` lists what isn't checked yet.

`tidysum serve` records findings in the `misallocation` table after every sync (the CLI command
does too). A finding is `open` while it is still found; `dismissed` when you say it isn't for
you (`pnpm tidysum misallocation dismiss <id>`, or the button on the admin page), which leaves it
out of the total; `resolved` when it goes away because you acted (you now hold the suggested
account or card, or the fee stopped); and `withdrawn` when it goes away for another reason. A
finding that comes back reopens. Every transition is an `audit_event`. For resolved findings,
`realized_annual_value` is what acting actually gained, where Tidysum can measure it: interest
the new bank paid since the switch, annualized, minus what the old account earned (from 30
days after the switch), or a fee that stopped. Card rewards aren't measured yet.
`list_misallocations` over MCP reads the record.

Generate `TIDYSUM_TOKEN_KEY` with `openssl rand -base64 32`. Plaid keys are on the Plaid
dashboard under Developers → Keys; [Connect your accounts](connect-your-accounts.md) walks through
the free Plaid account and linking step by step.

## Installed with install.sh

`curl -fsSL https://lucidity-finance.github.io/tidysum/install.sh | sh` installs everything in
`~/.tidysum` with no prerequisites ([decision 0012](decisions/0012-one-step-install.md)): its own
Node.js, Tidysum at one commit (`app/current`), Tidysum's own Postgres, your `.env` and the logs.
The `tidysum` command is linked into `~/.local/bin`, and every command above works as `tidysum
<command>` from any folder. On top of them:

| Command                  | What it does                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tidysum start [--open]` | Runs `serve` in the background, at login too (a launchd agent, `com.tidysum.app`, on a Mac; a systemd user service, `tidysum.service`, on Linux; else a plain background process), and waits for the page |
| `tidysum stop`           | Stops the page and its database, and keeps them stopped until `start`                                                                                                                                     |
| `tidysum restart`        | After changing `~/.tidysum/.env`                                                                                                                                                                          |
| `tidysum status`         | Whether the page and database run, then Items and balances                                                                                                                                                |
| `tidysum logs [-f]`      | The page's log, `~/.tidysum/logs/serve.log`                                                                                                                                                               |
| `tidysum upgrade`        | Installs the newest `main` next to the current version, migrates, switches and restarts; goes back if the migration fails                                                                                 |
| `tidysum uninstall`      | Removes the program and the service; your data stays in `~/.tidysum` until you delete it                                                                                                                  |

The installer's settings are environment variables, listed at the top of `install.sh`:
`TIDYSUM_HOME` (another folder), `TIDYSUM_REF` (a branch, tag or commit), `TIDYSUM_BIN_DIR`,
`TIDYSUM_NO_MODIFY_PATH=1`, `TIDYSUM_NO_START=1` and `TIDYSUM_SOURCE` (install a local checkout).

### Tidysum's own Postgres

With `DATABASE_URL` empty, every command uses a PostgreSQL 17 cluster in `$TIDYSUM_HOME/postgres`
(default `~/.tidysum/postgres`) and makes or starts it first if it has to (`src/db/localPostgres.ts`).
The binaries come with the install, from the `@embedded-postgres/<platform>` packages for macOS and
Linux. It listens only on a Unix socket in `postgres/run`, a folder only you can open, and never
on a network port. Its roles, grants, row-level security and `numeric` columns are the same as on
any other Postgres. `TIDYSUM_PG_BIN` points it at another PostgreSQL 17 `bin` folder; setting
`DATABASE_URL` uses that database instead, as a checkout with Docker does.

## Running on your Mac from a checkout

Tidysum runs locally; there is no server deploy. `deploy/macos-setup.sh` starts Postgres in
Docker (restarts with Docker Desktop) and installs a launchd agent that runs `tidysum serve`
at login: the admin page on http://127.0.0.1:8080 and a Plaid sync every
`SYNC_INTERVAL_MINUTES`. A connection that failed on Plaid's or the bank's side (a server error,
the bank not answering) is tried again every `SYNC_RETRY_MINUTES` until it syncs. The page has no sign-in because it only listens on loopback, and it
refuses requests whose Host isn't loopback, so a web page can't reach it by DNS rebinding. It creates
`policy.json` from the example and loads it if you have no policy yet. Re-run it after pulling; logs go to
`~/Library/Logs/tidysum/serve.log`. `deploy/macos-setup.sh uninstall` removes the agents.

After that the Mac deploys itself. A second agent, `com.tidysum.auto-deploy`, runs
`deploy/auto-deploy.sh` every minute: when `main` on GitHub has a commit the Mac isn't running, it
fast-forwards the clone, re-runs `deploy/macos-setup.sh` and waits for `/healthz`. If that fails it
puts the previous commit back, retries twice, and then shows a macOS notification. It won't touch a
clone that is on another branch or has local edits or commits, and it waits for Docker Desktop
after login. The last result is in `.deploy/status` in the clone, the full history in
`~/Library/Logs/tidysum/auto-deploy.log`. Set `TIDYSUM_AUTO_DEPLOY=off` in `.env` and re-run the
setup script to turn it off.

Without a public URL there are no Plaid webhooks, so Item errors show up at the next scheduled
sync instead of immediately.

## Layout

```
src/
  cli.ts                  migrate | link-sandbox | sync | serve | mcp | demo | check | proposals | products | cards | ...
  demo/                   the demo household (realWorld.ts: its real rates and sources), a Plaid stand-in that serves it, and the demo's seeding
  mcp/                    MCP server: tools, queries, tidysum_agent/tidysum_proposer connections
  policy/                 policy file schema, snapshot reads, deterministic checks, proposals
  products/               deposit and credit card catalogs, "what not switching costs" and card math
  server/                 Hono admin page + API, Plaid webhook endpoint
  ingest/csv.ts           CSV import with exact decimal parsing
  config.ts               env parsing (zod)
  crypto/tokenCipher.ts   AES-256-GCM for Plaid access tokens, bound to the item id
  db/schema.ts            Drizzle schema (source of truth for migrations)
  plaid/gateway.ts        the slice of Plaid Tidysum uses, in Tidysum's own types
  plaid/plaidApiGateway.ts  implementation over the official `plaid` client
  plaid/webhookVerifier.ts  Plaid-Verification JWT check
  sync/scheduler.ts       one sync at a time per Item, whoever asks
  sync/syncItem.ts        accounts + balances, /transactions/sync, holdings, liabilities
  portfolio/              allocation by target bucket, where new money goes, hand-entered holdings
catalog/                  deposit rates, card terms and fund asset-class splits, with sources
drizzle/                  generated + hand-written SQL migrations
test/                     vitest against a real Postgres (Testcontainers)
docs/                     decisions and spikes
```

## Design rules that already hold

- **Money is never a float.** Plaid's JSON numbers become decimal strings at the gateway
  edge and are stored as Postgres `numeric`.
- **Money is never added across currencies.** Each user has a country and home currency
  (`src/region.ts`, [decision 0011](decisions/0011-countries.md)); the policy snapshot leaves
  accounts in other currencies out, and findings are in the home currency.
- **US-only advice stays in the US.** Catalog entries carry a `country`, users see only their own,
  and US tax-law checks (401(k), IRA) run only for US users.
- **Amount sign follows Plaid:** positive is money out of the account, negative is money in.
- **Only the ingest side holds Plaid tokens.** They live encrypted in `item_secret`, which
  the `tidysum_agent` role is never granted. That role is read-only and table grants are
  explicit, so a new table stays invisible to agents until it is granted on purpose.
- **Transactions are never deleted.** Plaid removals set `removed_at`.
- **Sync is all-or-nothing per pagination run.** `/transactions/sync` pages are collected
  first and written in one database transaction with the new cursor; a mid-pagination
  mutation restarts from the original cursor, as Plaid requires.
- **Every record belongs to a user.** Personal tables carry `user_id`, and foreign keys
  include it, so a row can't point at another user's data. Agent connections set
  `tidysum.user_id` and row-level security limits them to that user's rows; with no user set they
  see nothing. Securities (market data) are shared. Commands act for `TIDYSUM_USER_ID`, or the only
  user when there is one.
- **Institution text is untrusted.** Transaction names and merchant names are data, never
  instructions, for any agent that reads them.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test                 # starts a throwaway Postgres container
pnpm db:generate          # after editing src/db/schema.ts
```

Locally, tests use a Testcontainers Postgres (needs Docker). Without Docker, `TEST_PG=local pnpm
test` runs them on Tidysum's own Postgres in a temp directory, and `TEST_PG_BIN` set to a
PostgreSQL `bin` directory does the same with that Postgres. Postgres won't run as root, so run
these as a normal user.

Secrets stay in `.env` (git-ignored). A gitleaks pre-commit hook is configured in
`.pre-commit-config.yaml` and runs in CI.

## CI

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the tests and a gitleaks scan of the whole
history on GitHub-hosted runners, which are free for public repositories. It runs on every push to
this repository and on pull requests from forks. Tests start a throwaway Postgres in Docker, as
they do locally.
