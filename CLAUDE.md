# Tidysum: notes for coding agents

- Read "Design rules that already hold" in docs/guide.md before changing sync or schema code.
- Every feature is a step of the misallocation loop in `docs/decisions/0003-misallocation-loop.md`:
  find, price in dollars per year, propose, approve, act, verify. Investment advice
  (`securities`) only runs for users with `investing_enabled`.
- Design every feature to `docs/decisions/0002-product-principles.md`: MCP-first, actions only
  through proposals, record recommendations and outcomes, no referral money in rankings, no
  securities advice for other users before registration.
- Never use JS numbers for money. Decimal strings in, Postgres `numeric` at rest.
- Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate`. Role grants and CHECK
  constraints are hand-written custom migrations in `drizzle/`.
- A new table is not readable by `tidysum_agent` until a migration grants it. Never grant
  `item_secret` or `item.transactions_cursor`.
- Nothing may move money without an approved proposal. Until Phase 4 there is no code
  path that can.
- Run `pnpm typecheck && pnpm lint` before every push, and `pnpm test` before finishing. Every
  failed CI run emails the account owner, so a branch must never be pushed red.
- CI runs only on the self-hosted `tidysum-ci` runner (`runs-on: [self-hosted, tidysum-ci]`).
  Never use GitHub-hosted runners such as `ubuntu-latest`; they spend the account's paid minutes.
- Merging to main deploys to the owner's Mac by itself within about a minute
  (`deploy/auto-deploy.sh`, launchd agent `com.tidysum.auto-deploy`). Don't run deploys by hand;
  to confirm one, read `.deploy/status` in the Mac's clone (`result=ok` and the merge commit).
