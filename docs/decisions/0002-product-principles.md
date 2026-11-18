# 0002: Product principles for a productizable Tidysum

Date: 2026-10-30
Status: accepted (the owner: "make sure we design our system and everything with the principles you
laid out in your doc")

Source: a research report on how AI money managers productized. It found that in 2026 ChatGPT,
Perplexity and (in testing) Claude all added read-only,
Plaid-connected personal finance, OpenAI hired Hiro's team and shut its app, and brokers such as
Robinhood let outside agents trade over MCP while disclaiming responsibility for them. Tidysum's
place is the layer in between: deciding, acting within limits, and accounting for it.

## Principles

1. **MCP-first.** Tidysum is the backend a user's own assistant calls. Every capability ships as
   an MCP tool first. The HTTP surface stays small: linking accounts, webhooks, approvals.
   Tidysum has no chat of its own: the owner talks ideas through with their own assistant, and
   the admin page shows actions and takes approvals (owner, 2026-11-12: "we don't need a chat in
   the UI"; the Ask panel added 2026-11-11 was removed). Tidysum's drafts of actions come from its
   detectors. There is no built-in agent: the owner brings
   their own, and it carries out approved actions through MCP, except trades, which Tidysum
   places itself (decision 0005).
2. **Tidysum owns the action layer.** Policy limits, proposals and human approval are the
   product. Nothing moves money without an approved proposal, and execution re-checks the
   proposal against current data.
3. **The proposal ledger is the compliance record.** Every recommendation that could lead to
   action records the policy version, the numbers and data it used, and who decided what and
   when. `audit_event` stays append-only and nothing in it is ever deleted (plan for at least
   7 years of retention). Deleting a user's data keeps their audit events, evidence snapshots
   included, for those 7 years (owner, 2026-10-30). The active policy doubles as the user's suitability profile.
4. **Measure outcomes so we can price on them.** A recommendation must be traceable from
   "proposed" to "acted on" to "money actually saved or earned", so a share-of-savings price
   is possible later. Quantify every suggestion in dollars per year.
5. **No referral money in rankings.** Catalogs rank by value to the user only. If a product
   ever pays Tidysum, that payout lives in a separate, disclosed field that ranking code never
   reads.
6. **Aggregator-neutral.** Plaid sits behind the gateway interface. Provider ids and shapes
   stay in the ingest layer, so MX or Finicity can be added as a second source.
7. **Generic, per-user, no personal values in code.** Every user-data table carries
   `user_id` with row-level security (see README). Personal values live in the database or
   git-ignored files, never in checked-in code or catalogs.
8. **Regulation in stages.** Cash and card recommendations can ship to other users without
   registration. Personalized investment advice for anyone other than the operator needs SEC
   internet adviser registration first. Investment proposals stay non-discretionary: the user
   approves each trade, and it executes in the user's own brokerage account. Automatic
   execution for other users is out of scope until a separate decision.
9. **Honest claims and easy exits.** No exaggerated savings or speed claims, clear disclosures,
   and one-step cancellation and data deletion (the FTC fined Cleo $17M in 2025 over both).
10. **Untrusted text stays data.** Institution text, catalog text and anything fetched is never
    an instruction to an agent.

## Where the code stands (audit, 2026-10-30, at 4952d46)

- **1 MCP-first: partial.** 15 MCP tools (`src/mcp/server.ts`). The HTTP side is linking, webhooks
  and owner decisions, but also read-only views of products, cards and misallocations
  (`src/server/app.ts:236-275`), and dismissing a finding or proposal and naming a card exist only
  there and in the CLI.
- **2 Action layer: followed.** No code can move money (no transfer or order calls anywhere).
  Proposals are validated against hard limits (`src/policy/engine.ts` `validateProposal`);
  approval re-validates against the active policy and the latest data (`approveProposal`).
- **3 Ledger = compliance record: followed.** Proposals keep `policy_version_id`, `validation` and
  the snapshot as `evidence` (`src/policy/proposals.ts`); findings keep inputs and catalog version
  (`src/misallocation/detect.ts`); `audit_event` is append-only by trigger
  (`drizzle/0005_proposal_roles.sql:22-32`). Every decision is recorded with actor `admin`, which
  needs a real identity once there is end-user auth.
- **4 Outcomes: partial.** Findings are priced per year and followed from found to resolved with
  realized value (`src/misallocation/ledger.ts`). Proposals stop at `approved`: no execution
  or realized value, and `finding_key` is free text, not a link to a ledger row.
  `best_card_for_purchase` answers aren't recorded.
- **5 No referral money: followed.** Catalogs have no payout field; every product answer carries
  `DISCLOSURE` (`src/products/disclosure.ts`); welcome bonuses are never counted.
- **6 Aggregator-neutral: partial.** Plaid sits behind `PlaidGateway` (`src/plaid/gateway.ts`),
  but core tables have `plaid_*` id columns and Plaid's category codes are the shared vocabulary
  (detectors match `BANK_FEES_*`, `INCOME_INTEREST_EARNED`; card catalog `codes.plaid`). Keying
  codes by provider leaves room for a second one.
- **7 Generic, per-user: followed.** `user_id` and RLS on every user table
  (`drizzle/0007_tenant_rls.sql`), policy per user in the database, no personal values in code or
  catalogs (`policy.json` is git-ignored).
- **8 Regulation in stages: followed.** Findings and proposals carry `category`; allocation checks
  and trade proposals need `app_user.investing_enabled` (`src/policy/engine.ts` `evaluatePolicy`,
  `validateProposal`).
- **9 Honest claims, easy exits: followed.** `src/exits.ts`: `tidysum item remove` and the admin
  page's Remove button revoke a connection at Plaid and delete its data; `tidysum user delete`
  does that for every connection and deletes the user. The audit log is kept, evidence included,
  for at least 7 years (owner, 2026-10-30). Realized savings are no longer counted from a
  connection that stopped syncing, or from one that was removed.
- **10 Untrusted text: followed.** Every tool that returns institution or agent text says so
  (`check_policy`, `list_proposals`, `list_misallocations` added in the audit PR).

Decision 0003's loop: find and price hold for cash and cards (six detectors, one ranked list); a
finding without a dollar figure stays a warning; securities and loan refinancing are listed as
not covered. Propose and approve hold (approval re-validates and records evidence). Act and verify for
proposals are Phase 4; verify holds for findings the user fixes themselves.

Gaps, most important first:

1. **Close the loop for proposals (4, 0003 steps 5-6).** An execution record (re-validated
   again at execution), realized value, and a real link from a proposal to the ledger row it fixes.
   This is Phase 4.
2. **Owner decisions over MCP (1).** Dismissing a finding and naming a card are owner-only
   today; when end-user auth exists, decide which of these an assistant may do for the user.
3. **Aggregator-neutral ids and categories (6).** When a second aggregator arrives, move to a
   provider plus external-id pair, and map provider categories to Tidysum's own.
4. **Record per-purchase card advice (4).** Low value until there is an outcome to tie it to.
