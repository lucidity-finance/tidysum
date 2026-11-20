# 0013: SimpleFIN Bridge as a second way to connect accounts

Date: 2026-11-20
Status: accepted (the owner: "We should add support for that Plaid alternative ... I think that
sounds like a good idea to add support for that.")

## Context

Plaid is how Tidysum reads accounts, and its free Trial plan is generous, but it asks for a sign-up
form, an identity check and two keys in `.env`, caps a person at 10 connections, and Plaid can turn
an applicant down. That is the steepest step of a self-hosted install, and it is where people stop.

[SimpleFIN](https://www.simplefin.org/protocol.html) is an open, read-only protocol for bank data.
Its main server, SimpleFIN Bridge, costs the person about $15 a year, connects up to 25 US
institutions, and gives any app a one-time setup token. The app needs no account or keys of its
own. Other self-hosted finance tools already use it (Actual Budget, Firefly III's importer, Open
Net Worth), so people who self-host often have a Bridge account already.

## Decision

SimpleFIN is a connector beside Plaid and Enable Banking (decision 0011), behind the same sync
gateway (`src/plaid/gateway.ts` `SyncGateway`), so its accounts land in the same tables and every
check reads them the same way. Code: `src/simplefin/`.

- **Linking:** the person pastes a setup token on the Connections page (or pipes it to
  `tidysum simplefin -`). Tidysum claims it for an access URL and stores that encrypted in
  `item_secret`, like a Plaid access token. It is never granted to `tidysum_agent`.
- **One item per bank.** One access URL covers every bank at the Bridge; Tidysum still keeps one
  item per SimpleFIN connection, so names, statuses, Reconnect and removal work per institution as
  they do with Plaid. The banks of one access URL share each answer, so syncing five banks costs
  one request. "Check for new banks" asks the stored access URL again and adds new ones only.
- **Staying inside the Bridge's limits:** about 24 requests a day per access URL, or the token is
  disabled. Tidysum caps itself at 20 a day, asks in windows of 44 days (the Bridge recommends 45
  or fewer), shares answers for five minutes, and reads about a year of history on the first sync,
  stopping at the first empty window. A normal sync is one request.
- **No types or categories in SimpleFIN:** account kinds come from holdings, names and a balance
  below zero; Plaid's categories come from the merchant category code the Bridge sends (card
  rewards are defined by it) or from unmistakable descriptions (card payments, transfers, interest
  paid, interest charged, fees, payroll). Unclear stays uncategorised, like Plaid's "other".
- **Holdings:** the Bridge's holdings extension (symbol, shares, market value, cost basis) becomes
  holdings and securities; a security's id is its ticker (`sf:VTI`), so everyone's VTI is one row.
  Money market and sweep funds count as cash.
- **Currencies:** accounts carry their ISO currency; points and miles (a custom currency URL) are
  skipped rather than counted as money.
- **Errors:** a bank wanting a new sign-in at the Bridge (`con.auth`) asks for attention on that
  bank only; access turned off (403) asks for a new token; a lapsed subscription (402) says so.
- **Read-only.** SimpleFIN has no way to move money, which fits "nothing moves money without an
  approved proposal".
- **No keys needed means Tidysum starts without any**: Plaid's keys stay optional, and the Link
  button offers whichever ways are available.

## Consequences

- A fresh install can connect real accounts in minutes without a Plaid account.
- SimpleFIN data is thinner than Plaid's: no card APRs or statement balances (liabilities), guessed
  account kinds, inferred categories, daily rather than live balances. The checks that need those
  have less to go on, as with open banking in Europe.
- The Bridge is a third party the person pays and trusts with their bank sign-ins, as with Plaid.
