# 0011: Users outside the US: a country per user, and US-only advice stays in the US

Date: 2026-11-20
Status: accepted (the owner: "we should support canada and UK and EU")

## Context

Tidysum was built for US accounts. Plaid Link only offered US banks, every amount was written
with "$" and added up whatever the account's currency, and much of the advice is US law or US
data: the 401(k), IRA and backdoor Roth checks, SEC fund fees, CFPB card terms, the Treasury bill
yield, and bank and card catalogs that list US products only.

What it takes to link accounts differs by country (checked 2026-11-20):

- **Canada:** Plaid's free Trial plan covers Canadian banks (transactions, balances, investments,
  some card liabilities), and people in Canada can sign up for it. Canada is close.
- **UK and EU:** Plaid's Trial plan is only open to developers in the US or Canada and only reaches
  US and Canadian banks. Plaid's European production access needs its business compliance
  process, which an individual running Tidysum for themselves can't go through. GoCardless Bank
  Account Data, the old free route, takes no new sign-ups. Enable Banking's free "restricted
  production" lets a person link their own accounts in the UK and EU, so it is the connector for
  them. Open banking there covers bank accounts and cards, not brokerages or pensions.
- **Investing and tax:** UK and EU investors can't buy US-domiciled ETFs (no KID under PRIIPs), so
  they hold UCITS funds. Tax wrappers differ: TFSA, RRSP and FHSA in Canada; ISA, SIPP and
  workplace pensions in the UK; per country in the EU.
- **Cards:** the UK and EU cap card interchange fees, so rewards cards are rare and card
  optimization matters far less there than in the US or Canada.

## Decision

1. **Each user has a country** (`app_user.country`, ISO code, default US) and with it a home
   currency (`src/region.ts`). `tidysum user country CA` sets it.
2. **Money is never added across currencies.** The policy snapshot keeps only accounts in the home
   currency and lists the rest; findings carry the home currency; the page and action steps write
   amounts with its symbol. Converting other currencies at a public reference rate can come later.
3. **Plaid Link offers banks from where the user lives:** US and Canada together on the free plan;
   a UK or EU country only with `PLAID_EUROPE=true` (a Plaid team with European access). Otherwise
   the page says why and points to CSV import.
4. **US-only advice switches off elsewhere instead of being wrong.** Bank and card catalog entries
   carry a `country` (default US) and users only see their own country's. The 401(k), IRA and
   backdoor Roth detectors only run in the US. The cash yardstick is the user's own government's
   bill yield: the US Treasury's, or the Bank of Canada's.
5. **Funds are facts wherever the reader lives.** The security catalog lists Canadian-listed funds
   (`country: CA`) beside US ones, Canadian stocks are a sleeve of international stocks (these
   styles split US and non-US), and a money style picked in Canada puts Canadian-listed funds first
   in each bucket. Only US funds take their fee from the SEC.
6. **Order:** Canada first, then the UK and EU bank connector (Enable Banking, below), then UK
   funds and rules (UCITS funds, ISA and SIPP, FSCS-protected savings, Bank of England rate), then
   the EU's (UCITS, the €100k deposit guarantee, ECB rate; tax wrappers country by country later).
7. **Using Tidysum for your own money is fine anywhere.** Offering advice to other people in these
   countries needs local authorization (FCA, Canadian securities regulators, MiFID firms), as the
   US needs SEC registration (decision 0002, principle 8).

## The UK and EU connector

Built after Canada: `src/enableBanking/`. The person registers their own Enable Banking
application (free for their own accounts) and gives Tidysum its id and private key; nothing runs
through a Tidysum server. Its sessions are stored like Plaid's access tokens (encrypted in
`item_secret`) and sync into the same tables through the same code, so every check works the same
way on what open banking provides: accounts, balances and booked transactions, without categories,
holdings or liabilities. Banks only send people back to https addresses, so the project's GitHub
Pages site has a forwarding page (`site/bank-callback.html`) that passes the answer on to a
Tidysum on 127.0.0.1 and nowhere else.

## Still to do for Canada

- Canadian savings accounts (CDIC) and cards in the catalogs, with their sources.
- TFSA, RRSP and FHSA room, the way the IRA checks work in the US.
- The all-in-one Vanguard and BMO portfolios (VEQT, VGRO, VBAL, ZEQT...) once their fact sheets'
  regional mixes are read; only XEQT is in so far.
