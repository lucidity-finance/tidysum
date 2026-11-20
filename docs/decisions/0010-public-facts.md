# 0010: Product facts come from providers and public data, never from referral feeds

Date: 2026-11-20
Status: accepted (the owner asked for "data sources, some APIs or MCPs" to get "the latest info"
instead of hand-checked files, and picked "Government import + AI-checked facts")

## Context

Every recommendation rests on product facts: bank APYs and fees, card rewards and fees, what funds
charge. They lived in checked-in catalogs that a person re-checked against each provider's page,
and went stale after 30 days. We looked for live sources. Rate aggregators with APIs or MCP
servers (Bankrate, NerdWallet, DepositAccounts, SwitchWize) are paid when a reader opens an
account, and their terms forbid redistributing the data; card-data vendors charge up to $499 a
month to allow it. No free, neutral, redistributable source of bank APYs or card reward rates
exists. US government data covers more than expected: fund fee tables (SEC), card fees and APRs
(CFPB) and Treasury yields, all free and public.

## Decision

1. **Government data is fetched by Tidysum itself.** `tidysum serve` imports the SEC's prospectus
   risk/return data sets (expense ratios, monthly), the CFPB's Terms of Credit Card Plans survey
   (twice a year) and the Treasury's daily bill rates, each when it's due, into shared market-data
   tables agents can read. They answer `fund_fees`, `card_terms` and `benchmark_rates`, fill
   funds' missing expense ratios, and flag catalog cards whose fees the survey states otherwise.
2. **The rest stays in the catalogs, and the owner's agent keeps it current.** `list_stale_facts`
   names each product to re-check and its page; the agent reads the provider's own page and
   records `confirmed`, `changed` or `not_found` with `submit_fact_check`, quoting the sentence
   that states the numbers. Tidysum refuses pages on another site and quotes that don't contain
   each new value, and lays accepted checks over the catalog files; a newer file edit wins.
3. **No aggregator or referral feed is ever a source of a number Tidysum prices with.** They may
   help a person or an agent discover a product, nothing more (decision 0002).

## Consequences

- Fund fees need no upkeep, and card fees get a second, independent source.
- Bank rates and reward rates are only as fresh as the owner's agent keeps them. A user who never
  runs an agent sees the stale flags, as before.
- Checks are shared across users, like other market data: one agent's check helps everyone on the
  same Tidysum. Row-level security records each as its agent's own user.
- A hosted Tidysum later could license a card-rewards feed; that would be a new decision.
