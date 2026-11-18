import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { draftActions, listActions } from "./actions/actions.js";
import {
  checkSchedule,
  commandDispatch,
  logNotify,
  macNotify,
  type Notify,
  parseSchedule,
  scheduleAction,
} from "./actions/schedule.js";
import { setupAgent } from "./agentSetup.js";
import {
  agentCommand,
  agentHours,
  cardsPath,
  isLoopbackHost,
  loadDbConfig,
  loadPlaidConfig,
  loadServerConfig,
  minerDir,
  minerIntervalHours,
  minerUrl,
  notifyMode,
  planPath,
  productsPath,
  securitiesPath,
} from "./config.js";
import { TokenCipher } from "./crypto/tokenCipher.js";
import { connect, type DbHandle, runMigrations } from "./db/client.js";
import {
  account,
  appUser,
  balanceSnapshot,
  financialPlan,
  iraYear,
  item,
  policyVersion,
  syncRun,
  workplacePlan,
} from "./db/schema.js";
import { deleteUser, removeItem } from "./exits.js";
import { importCsv } from "./ingest/csv.js";
import { refreshVix } from "./market/calm.js";
import { type AgentDb, connectAgent, connectProposer } from "./mcp/agentDb.js";
import { createTidysumMcpServer, type PolicyTools, type ProductTools } from "./mcp/server.js";
import { loadCatalogs, misallocationReport } from "./misallocation/detect.js";
import {
  listMisallocations,
  refreshMisallocations,
  setMisallocationState,
} from "./misallocation/ledger.js";
import { PlaidApiGateway } from "./plaid/plaidApiGateway.js";
import { PlaidWebhookVerifier } from "./plaid/webhookVerifier.js";
import { setPlanFile } from "./plan/plan.js";
import { evaluatePolicy } from "./policy/engine.js";
import { loadPolicyFile } from "./policy/policy.js";
import { listProposals } from "./policy/proposals.js";
import { readSnapshot } from "./policy/snapshot.js";
import { activatePolicy, loadActivePolicy } from "./policy/store.js";
import { readAllocation } from "./portfolio/allocation.js";
import {
  listManualHoldings,
  removeManualHolding,
  setManualHolding,
} from "./portfolio/manualHoldings.js";
import { loadSecurityCatalogFile } from "./portfolio/securityCatalog.js";
import { setCardAssignment } from "./products/cardAssignments.js";
import { loadCardCatalogFile } from "./products/cardCatalog.js";
import {
  adviseOnPurchase,
  compareCards,
  merchantCategory,
  readCardFees,
  readHeldCards,
  readSpending,
  totalInterest,
} from "./products/cards.js";
import { readCashHistoryReport } from "./products/cashHistory.js";
import { loadCatalogFile } from "./products/catalog.js";
import { readAndCompare } from "./products/compare.js";
import { cliMinerSource } from "./research/miner.js";
import { readResearchReport } from "./research/report.js";
import { httpMinerApi, ResearchScanner, readMinerPassword } from "./research/scan.js";
import { importResearch } from "./research/store.js";
import { setIraYear } from "./retirement/ira.js";
import { readWorkplacePlans, setWorkplacePlan } from "./retirement/workplace.js";
import { createApp } from "./server/app.js";
import { linkItem } from "./sync/items.js";
import { SyncScheduler } from "./sync/scheduler.js";
import { syncItem } from "./sync/syncItem.js";
import { createUser, resolveUserId } from "./users.js";

const USAGE = `tidysum <command>

  migrate                          apply database migrations
  link-sandbox [institution_id]    create and link a Plaid Sandbox Item (default ins_109508)
  sync                             sync every active Item once
  serve                            admin page (Plaid Link), Plaid webhooks, scheduled sync, and
                                   the agent MCP endpoint at /mcp when TIDYSUM_MCP_TOKEN is set
  agent setup [--dry-run]          connect your own Claude Code to Tidysum, once: adds the MCP
                                   server and the tidysum-actions skill, and allows Tidysum's MCP
                                   tools and its command line in this repo so the agent isn't
                                   stopped at every step (neither can move money)
  mcp                              MCP server for agents, over stdio: read tools, policy checks,
                                   and create_proposal (which never executes anything)
  policy set <file> [--if-missing] make a policy file the user's active policy (stored in the
                                   database; --if-missing only if the user has none yet)
  policy show                      print the active policy
  plan set [file] [--if-configured]
                                   store your written plan (Markdown: goals, target mix, rules)
                                   so the admin page shows it and agents follow it; file defaults
                                   to TIDYSUM_PLAN_FILE (--if-configured: do nothing when neither)
  plan show                        print the stored plan
  workplace set <account_id> <file>
                                   record what a workplace retirement plan's site shows
                                   (contribution elections, the match, fund lineup and fees);
                                   see workplace.example.json
  workplace show                   the recorded workplace plans
  ira set <file>                   record what went into IRAs for one tax year (Roth,
                                   traditional, converted; filing status and MAGI optional);
                                   see ira.example.json. Finished IRA actions record themselves
  ira show                         the recorded IRA years
  research import                  read investment-miner's newest current run per watchlist
                                   (TIDYSUM_MINER_DIR; serve also does this every hour)
  research scan [assets]           ask investment-miner's API to scan the institutional
                                   watchlists now (or the asset watchlist), wait, then import
  research                         the research sleeve against its cap, and the miner's ranked
                                   candidates with the evidence behind them
  check                            run the policy checks against the active policy
  proposals                        list recent proposals
  allocation                       your investments by target bucket, in percent, and where
                                   new money should go to reach the target (no dollar amounts)
  manual set <name> --class <class> --value <n> [--as-of <date>] | manual remove <name> | manual list
                                   investments no data source reaches (TreasuryDirect), entered
                                   by hand; class is one from catalog/securities.json (bonds)
                                   (TIDYSUM_SECURITIES_FILE, default catalog/securities.json)
  products                         compare cash accounts with better checking and savings
                                   products, and what not switching costs per year
                                   (TIDYSUM_PRODUCTS_FILE, default catalog/deposit-products.json)
  cash-history                     your cash balances day by day over up to two years, and the
                                   interest the cash above your buffer lost by not sitting in a
                                   high-yield account
  cards [--card <account_id>=<card_id>]...
                                   last year's spending, what your credit cards earn on it, and
                                   new cards that would pay for themselves
                                   (TIDYSUM_CARDS_FILE, default catalog/credit-cards.json)
  card-for [--merchant <name>] [--category <key>] [--amount <n>] [--foreign]
           [--card <account_id>=<card_id>]...
                                   which of your cards to use for a purchase
  actions                          the Actions queue: waiting for you, in progress, scheduled
  action schedule <file>           add an action that waits for a day (not_before) or has a last
                                   day (due_by), for you to approve on the Actions page; see
                                   scheduled-action.example.json
  due                              check the actions' days now (serve does it every hour): note
                                   and tell you what came due, and start your agent on approved
                                   ones when TIDYSUM_AGENT_COMMAND is set
  misallocations                   find and record everything costing you money, ranked by
                                   cost per year, and what acting on past findings gained
  misallocation dismiss|undismiss <id>
                                   say a finding isn't for you, or take that back
  card-set <account_id> <card_id|none>
                                   say which catalog card a linked account is, when the
                                   bank's name for it is too generic
  import-csv <file> --institution <name> --account <name> --type <type>
             [--subtype <s>] [--currency USD] [--date-col Date] [--amount-col Amount]
             [--desc-col Description] [--flip-sign] [--balance <amount>]
                                   import transactions for an institution Plaid can't reach.
                                   Amounts are stored positive = money out; pass --flip-sign
                                   for exports where purchases are negative.
  status                           show Items, accounts, latest balances and last sync
  item remove <item_id>            disconnect an Item: revoke it at Plaid and delete its accounts
                                   and everything synced from them (the audit log is kept)
  users                            list users
  user add <name> [--investing]    add a user; --investing only for someone managing their own
                                   money (investment advice to others needs registration)
  user delete <user_id> --yes      revoke every Item at Plaid and delete all of the user's data;
                                   only the audit log is kept, for at least 7 years

Commands act for TIDYSUM_USER_ID, or for the only user when there is just one.`;

/** Ask for the maximum history at link time; Plaid's default is about 90 days. */
const DAYS_REQUESTED = 730;

function plaidDeps() {
  const config = loadPlaidConfig();
  return { plaid: new PlaidApiGateway(config), cipher: new TokenCipher(config.TIDYSUM_TOKEN_KEY) };
}

async function syncAll(h: DbHandle) {
  const { plaid, cipher } = plaidDeps();
  const items = await h.db
    .select({ id: item.id, name: item.institutionName })
    .from(item)
    .where(and(eq(item.source, "plaid"), inArray(item.status, ["active", "error"])));
  for (const it of items) {
    const r = await syncItem(h.db, plaid, cipher, it.id);
    const detail = r.status === "succeeded" ? `+${r.added} ~${r.modified} -${r.removed}` : r.error;
    console.log(`${it.name ?? it.id}: ${r.status} ${detail}`);
  }
}

async function runServer(h: DbHandle) {
  const server = loadServerConfig();
  const userId = await resolveUserId(h.db);
  const agentDb = connectAgent(loadDbConfig().DATABASE_URL, userId);
  const { plaid, cipher } = plaidDeps();
  const scheduler = new SyncScheduler(h.db, plaid, cipher, (r) => {
    const detail = r.status === "succeeded" ? `+${r.added} ~${r.modified} -${r.removed}` : r.error;
    console.log(`sync ${r.itemId}: ${r.status} ${detail}`);
  });
  const policy = policyTools(loadDbConfig().DATABASE_URL, userId, agentDb);
  // investment-miner scans on its own schedule (weekday evenings, UTC) and on request from the
  // Investments page; either way Tidysum imports the new runs.
  const miner = minerDir();
  const readMiner = miner
    ? () =>
        importResearch(h.db, cliMinerSource(miner))
          .then((r) => {
            if (r.imported.length) console.log(`research: imported ${r.imported.join(", ")}`);
            if (!r.ok) console.error(`research: ${r.error}`);
          })
          .catch((err) => console.error("research import failed:", err))
    : undefined;
  const app = createApp({
    db: h.db,
    plaid,
    cipher,
    scheduler,
    verifier: new PlaidWebhookVerifier(plaid),
    // On loopback the page is open to this machine; a password only guards a wider bind.
    ...(isLoopbackHost(server.HOST) ? {} : { adminToken: server.TIDYSUM_ADMIN_TOKEN }),
    ...(server.TIDYSUM_PUBLIC_URL
      ? { webhookUrl: new URL("/webhooks/plaid", server.TIDYSUM_PUBLIC_URL).toString() }
      : {}),
    daysRequested: DAYS_REQUESTED,
    linkSessionRetryMs: 1000,
    userId,
    agentDb,
    ...(server.TIDYSUM_MCP_TOKEN
      ? { mcp: { token: server.TIDYSUM_MCP_TOKEN, policy, products: productTools() } }
      : {}),
    products: productTools(),
    ...(miner && readMiner
      ? {
          research: new ResearchScanner(
            httpMinerApi(minerUrl(), () => readMinerPassword(miner)),
            readMiner,
          ),
        }
      : {}),
  });
  serve({ fetch: app.fetch, hostname: server.HOST, port: server.PORT }, (info) =>
    console.log(`tidysum listening on ${server.HOST}:${info.port}`),
  );
  const products = productTools();
  // Record what the data shows is in the wrong place, then turn what's open into actions.
  const reassess = async () => {
    await refreshMisallocations(h.db, agentDb, userId, await loadCatalogs(products), today())
      .then((r) => {
        if (r.found + r.changed + r.reopened + r.resolved + r.withdrawn > 0) {
          console.log(
            `misallocations: ${r.found} found, ${r.changed} changed, ${r.reopened} reopened, ` +
              `${r.resolved} resolved, ${r.withdrawn} withdrawn`,
          );
        }
      })
      .catch((err) => console.error("misallocation pass failed:", err));
    // Then turn what's open into actions for the owner to decide, one at a time.
    await draftActions(
      h.db,
      userId,
      new Date(),
      await allocationNow(agentDb),
      await readWorkplacePlans(agentDb),
    )
      .then((r) => {
        if (r.drafted + r.updated + r.superseded + r.confirmed + r.withdrawn > 0) {
          console.log(
            `actions: ${r.drafted} drafted, ${r.updated} updated, ${r.superseded} superseded, ` +
              `${r.confirmed} confirmed, ${r.withdrawn} withdrawn`,
          );
        }
      })
      .catch((err) => console.error("action pass failed:", err));
  };
  const tick = async () => {
    await scheduler.syncAll().catch((err) => console.error("sync pass failed:", err));
    await reassess();
  };
  void tick();
  setInterval(tick, server.SYNC_INTERVAL_MINUTES * 60_000);
  // Scheduled actions (decision 0006): every hour, see what came due and tell the owner. Data
  // recorded by hand (a workplace plan, an IRA year) and agents' finished actions count then too,
  // without waiting for the next sync.
  const schedule = scheduleRunner(h.db, agentDb, userId);
  void schedule();
  setInterval(async () => {
    await reassess();
    await schedule();
  }, 60 * 60_000);
  if (readMiner) {
    void readMiner();
    setInterval(readMiner, minerIntervalHours() * 3_600_000);
  }
  // Keep the pool open for the life of the process.
  await new Promise(() => {});
}

function notifier(): Notify | undefined {
  const mode = notifyMode();
  return mode === "macos" ? macNotify : mode === "log" ? logNotify : undefined;
}

/** One pass over the actions' days, logged; what `serve` runs every hour and `due` once. */
function scheduleRunner(db: DbHandle["db"], agentDb: AgentDb, userId: string) {
  const command = agentCommand();
  const notify = notifier();
  return async () => {
    // Calm markets (decision 0008): today's VIX, before the actions are looked at.
    await refreshVix(db, today()).catch((err) =>
      console.error("VIX fetch failed:", (err as Error).message),
    );
    return checkSchedule(db, agentDb, userId, today(), {
      ...(notify ? { notify } : {}),
      ...(command ? { dispatch: commandDispatch(command) } : {}),
      hour: new Date().getHours(),
      hours: agentHours(),
    })
      .then((r) => {
        const n = r.due.length + r.due_soon.length + r.overdue.length + r.dispatched.length;
        if (n > 0) {
          console.log(
            `schedule: ${r.due.length} due, ${r.due_soon.length} due soon, ` +
              `${r.overdue.length} overdue, ${r.dispatched.length} handed to your agent`,
          );
        }
        return r;
      })
      .catch((err) => {
        console.error("schedule pass failed:", err);
        return null;
      });
  };
}

async function runDue(h: DbHandle) {
  const userId = await resolveUserId(h.db);
  const agentDb = connectAgent(loadDbConfig().DATABASE_URL, userId);
  try {
    const r = await scheduleRunner(h.db, agentDb, userId)();
    if (r && !r.due.length && !r.due_soon.length && !r.overdue.length && !r.dispatched.length)
      console.log("Nothing new came due.");
  } finally {
    await agentDb.end();
  }
}

async function runActions(h: DbHandle) {
  const userId = await resolveUserId(h.db);
  const agentDb = connectAgent(loadDbConfig().DATABASE_URL, userId);
  try {
    const r = await listActions(agentDb, today());
    const days = (a: (typeof r.queue)[number]) =>
      [
        a.not_before ? `from ${a.not_before}` : "",
        a.due_by ? `due by ${a.due_by}` : "",
        a.wait_for === "calm_markets"
          ? a.timing === "waiting"
            ? `waits for calm markets, VIX ${a.market?.vix ?? "unknown"}`
            : `markets calm, VIX ${a.market?.vix ?? "?"}`
          : "",
      ]
        .filter(Boolean)
        .join(", ");
    const line = (a: (typeof r.queue)[number]) => {
      const when = days(a);
      return `  ${a.id}  ${a.title}${when ? `  (${when}${a.timing === "overdue" ? ", overdue" : ""})` : ""}`;
    };
    for (const [label, list] of [
      ["Waiting for you", r.queue],
      ["In progress", r.in_progress],
      ["Scheduled", r.scheduled],
    ] as const) {
      console.log(`${label}: ${list.length ? "" : "none"}`);
      for (const a of list) console.log(line(a));
    }
    if (r.snoozed) console.log(`${r.snoozed} set aside for a week.`);
  } finally {
    await agentDb.end();
  }
}

/** The allocation for the investing action; undefined (leave it alone) if it can't be read. */
async function allocationNow(db: AgentDb) {
  try {
    return await readAllocation(db, await loadSecurityCatalogFile(securitiesPath()), today());
  } catch (err) {
    console.error("allocation read failed:", err);
    return undefined;
  }
}

function policyTools(databaseUrl: string, userId: string, agentDb: AgentDb): PolicyTools {
  return {
    proposer: connectProposer(databaseUrl, userId),
    loadPolicy: () => loadActivePolicy(agentDb),
  };
}

/** Resolves the acting user on a short-lived owner connection. */
async function currentUser(url: string): Promise<string> {
  const h = connect(url);
  try {
    return await resolveUserId(h.db);
  } finally {
    await h.close();
  }
}

function productTools(): ProductTools {
  const path = productsPath();
  const cards = cardsPath();
  return {
    loadCatalog: () => loadCatalogFile(path),
    loadCardCatalog: () => loadCardCatalogFile(cards),
    loadSecurityCatalog: () => loadSecurityCatalogFile(securitiesPath()),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/** stdout carries the MCP protocol, so nothing else may print to it. */
async function runMcp() {
  const url = loadDbConfig().DATABASE_URL;
  const userId = await currentUser(url);
  const db = connectAgent(url, userId);
  const policy = policyTools(url, userId, db);
  const server = createTidysumMcpServer(db, policy, productTools());
  server.server.onclose = () => {
    void db.end();
    void policy.proposer.end();
  };
  await server.connect(new StdioServerTransport());
}

async function runCheck() {
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const loaded = await loadActivePolicy(db);
    const findings = evaluatePolicy(
      loaded.policy,
      await readSnapshot(db, today()),
      await loadSecurityCatalogFile(securitiesPath()),
    );
    console.log(`policy ${loaded.versionId.slice(0, 12)}`);
    for (const f of findings) {
      const cost = f.annual_cost ? ` Costs ${f.annual_cost}/yr if left.` : "";
      console.log(`  [${f.status}] ${f.check}: ${f.summary}${cost}`);
    }
  } finally {
    await db.end();
  }
}

async function runResearch() {
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const r = await readResearchReport(db, today(), 10);
    if (r.state === "off") {
      console.log("research: investing is off for this user");
      return;
    }
    console.log(r.note);
    if (r.sleeve) {
      console.log(
        `Research sleeve: ${r.sleeve.current}% of investable assets, cap ${r.sleeve.cap}%${r.sleeve.over ? " (over: new money skips it)" : ""}`,
      );
    } else console.log("No research_sleeve in the policy: nothing may be bought from these lists.");
    for (const l of r.lists) {
      console.log(
        `\n${l.label}: run ${l.run.run_id}, ${l.run.status}${l.run.status === "partial" ? ` (${l.run.fetched_pct ?? "?"}% fetched)` : ""}, as of ${l.run.as_of} (${l.run.age_days} days${l.run.stale ? ", stale" : ""}), scoring v${l.run.scoring_version ?? "?"}`,
      );
      for (const lim of l.run.limitations) console.log(`  limitation: ${lim}`);
      for (const c of l.candidates) {
        const held = c.held ? ` [held: ${c.held}]` : "";
        console.log(`  ${c.rank}. ${c.ticker} ${c.name ?? ""} ${c.score ?? "n/a"}${held}`);
        console.log(`     ${c.summary}`);
      }
      if (l.biggest_drops.length) {
        console.log("  Biggest drops among its conviction picks:");
        for (const c of l.biggest_drops) {
          const held = c.held ? ` [held: ${c.held}]` : "";
          console.log(
            `    ${c.ticker} ${c.name ?? ""}: ${c.drop_pct}% below its high, rank ${c.rank}${held}`,
          );
        }
      }
    }
    for (const w of r.warnings) console.log(`! ${w}`);
  } finally {
    await db.end();
  }
}

async function runAllocation() {
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const r = await readAllocation(db, await loadSecurityCatalogFile(securitiesPath()), today());
    if (r.state !== "ready") {
      console.log(`allocation: ${r.state}`);
      return;
    }
    for (const b of r.buckets) {
      const sign = b.drift.startsWith("-") ? "" : "+";
      console.log(`  ${b.label}: ${b.current}% (target ${b.target}%, ${sign}${b.drift})`);
    }
    if (r.unclassified.percent !== "0.0") {
      const which = r.unclassified.holdings.map((x) => x.ticker ?? x.name).join(", ");
      console.log(`  not classified: ${r.unclassified.percent}% (${which})`);
    }
    if (!r.rebalance) console.log(`Within ${r.drift_band} points of every target.`);
    const nm = r.new_money;
    console.log(
      nm.basis === "target"
        ? "New money: follow the targets."
        : `New money, until about ${nm.catch_up ?? "?"}% of today's portfolio has gone in:`,
    );
    for (const s of nm.split) {
      console.log(`  ${s.percent}% ${s.bucket}${s.buy ? ` (${s.buy.ticker})` : ""}`);
    }
    if (r.moves.length) console.log("Or, to rebalance now by selling:");
    for (const m of r.moves) {
      console.log(`Move ${m.points} points from ${m.from} to ${m.to}:`);
      for (const s of m.sell) {
        const gain = s.gain === null ? "" : `, ${s.gain}% vs cost`;
        console.log(
          `  sell ${s.percent_of_position}% of ${s.ticker ?? s.name} in ${s.account_name}${gain}`,
        );
      }
      if (m.uncovered !== "0.0") console.log(`  sell ${m.uncovered} points from other holdings`);
      if (m.buy) console.log(`  buy ${m.buy.ticker}`);
    }
    for (const n of r.notes) console.log(n);
  } finally {
    await db.end();
  }
}

async function runProposals() {
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const { proposals } = await listProposals(db, { limit: 20 });
    if (proposals.length === 0) console.log("no proposals");
    for (const p of proposals) {
      console.log(`${p.created_at} [${p.state}] ${p.title} (${p.source})`);
      for (const a of p.actions) {
        const what =
          a.kind === "trade"
            ? `${a.side} ${a.amount} of ${a.symbol} in ${a.from_account}`
            : `${a.amount} from ${a.from_account} to ${a.to_account}`;
        console.log(`    ${a.seq}. ${a.kind}: ${what}`);
      }
      for (const v of p.validation.violations) console.log(`    blocked: ${v}`);
    }
  } finally {
    await db.end();
  }
}

async function runProducts() {
  const catalog = await loadCatalogFile(productsPath());
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const r = await readAndCompare(db, catalog, today());
    if (r.accounts.length === 0) console.log("no checking, savings or cash management accounts");
    for (const a of r.accounts) {
      const where = a.institution_name ? ` at ${a.institution_name}` : "";
      console.log(
        `${a.account_name}${where}: ${a.balance} (${a.balance_basis}), earning ` +
          `${a.current.annual_interest}/yr (${a.current.effective_apy}% effective), ` +
          `fees ${a.current.annual_fees}/yr`,
      );
      if (a.skipped) console.log(`    skipped: ${a.skipped}`);
      else if (a.alternatives.length === 0) console.log("    nothing in the catalog beats it");
      for (const alt of a.alternatives.slice(0, 3)) {
        const cond = alt.requires ? ` if ${alt.requires}` : "";
        console.log(
          `    +${alt.annual_gain}/yr  ${alt.name} at ${alt.apy}% APY${cond}` +
            ` (${alt.rates_as_of}, ${alt.source_url})${alt.stale ? " STALE" : ""}`,
        );
      }
    }
    console.log(
      `\nNot switching costs about ${r.annual_loss}/yr (${r.monthly_loss}/month); ` +
        `${r.annual_loss_without_conditions}/yr using only rates with no conditions.`,
    );
    for (const w of r.warnings) console.log(`warning: ${w}`);
  } finally {
    await db.end();
  }
}

async function runCashHistory() {
  const catalog = await loadCatalogFile(productsPath());
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const r = await readCashHistoryReport(db, catalog, today());
    if (!r.window) {
      for (const w of r.warnings) console.log(`warning: ${w}`);
      return;
    }
    console.log(
      `${r.window.from} to ${r.window.to} (${r.window.days} days), buffer ${r.buffer} (${r.buffer_basis})`,
    );
    for (const a of r.accounts) {
      const where = a.institution_name ? ` at ${a.institution_name}` : "";
      const check = a.check.snapshots
        ? `, ${a.check.snapshots} earlier balances off by at most ${a.check.largest_difference}`
        : "";
      console.log(
        `  ${a.name}${where}: now ${a.latest_balance}, averaged ${a.average_balance}, ` +
          `earned ${a.interest_earned} in interest${check}`,
      );
    }
    console.log("\nmonth     avg cash   above buffer   earned   would have earned   lost");
    for (const m of r.monthly) {
      console.log(
        `${m.month}  ${m.average_balance.padStart(10)} ${m.average_idle.padStart(12)} ` +
          `${m.interest_earned.padStart(10)} ${m.would_have_earned.padStart(16)} ${m.lost.padStart(10)}`,
      );
    }
    console.log("\nbenchmark (today's APY, no conditions)       would have earned     lost");
    for (const b of r.benchmarks) {
      console.log(
        `  ${`${b.name} ${b.apy}%`.padEnd(40)} ${b.would_have_earned.padStart(12)} ${b.lost.padStart(10)}`,
      );
    }
    console.log(
      `\nCash averaged ${r.average_balance}, ${r.average_idle} of it above the buffer, and earned ` +
        `${r.interest_earned}. In ${r.best?.name ?? "a high-yield account"} it would have earned ` +
        `${r.best?.would_have_earned ?? "0.00"}: ${r.lost} lost, about ${r.lost_per_year}/yr.`,
    );
    if (r.last_365_days) console.log(`Last 365 days: ${r.last_365_days.lost} lost.`);
    for (const w of r.warnings) console.log(`warning: ${w}`);
  } finally {
    await db.end();
  }
}

/** --card <account_id>=<card_id>, for cards the bank doesn't name. */
function cardOverrides(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const [account, card] = v.split("=");
    if (!account || !card) throw new Error(`--card expects <account_id>=<card_id>, got ${v}`);
    out[account] = card;
  }
  return out;
}

async function runCards(args: string[]) {
  const { values } = parseArgs({ args, options: { card: { type: "string", multiple: true } } });
  const catalog = await loadCardCatalogFile(cardsPath());
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const day = today();
    const r = compareCards(
      catalog,
      await readSpending(db, day),
      await readHeldCards(db),
      day,
      cardOverrides(values.card),
      totalInterest(await readCardFees(db, day)),
    );
    console.log(`Spending ${r.window.from} to ${r.window.to}:`);
    for (const c of r.spending.by_category) {
      console.log(
        `  ${c.label}: ${c.on_cards} on cards, ${c.from_bank} from bank` +
          (c.card_payable ? "" : ` (${c.card_note ?? "not usually card-payable"})`),
      );
    }
    if (r.spending.bank_payees.length) console.log("Paid from bank in categories cards take:");
    for (const p of r.spending.bank_payees) {
      const why = { could_go_on_card: "could go on a card", stopped: "stopped" }[
        p.status as string
      ];
      console.log(
        `  ${p.payee}: ${p.amount}, ${p.payments} payments, last ${p.last_date ?? "?"} (${why ?? p.note})`,
      );
    }
    console.log("Your cards:");
    for (const h of r.held_cards) {
      const pick = h.pick ? `; pick ${h.pick.choice} as ${h.pick.label}` : "";
      console.log(`  ${h.account_name} (${h.account_id}): ${h.card_name}${pick}`);
    }
    console.log(
      `Rewards per year: ${r.rewards.current} now, ${r.rewards.with_bank_spending_on_cards} with ` +
        `card-payable bank spending on your best card, ${r.rewards.with_recommended_cards} with ` +
        "the recommended cards (net of their fees)",
    );
    if (r.recommendations.length === 0) console.log("No card in the catalog would pay for itself.");
    for (const c of r.recommendations.slice(0, 5)) {
      const fee = c.annual_fee === "0.00" ? "no annual fee" : `${c.annual_fee} annual fee`;
      console.log(`  +${c.annual_gain}/yr  ${c.name} (${fee}; ${c.source_url})`);
      for (const e of c.earns_on) console.log(`      ${e.percent}% on ${e.spend} of ${e.category}`);
    }
    if (r.recommended_wallet.card_ids.length) {
      console.log(
        `Best to add: ${r.recommended_wallet.card_ids.join(" + ")}, ` +
          `+${r.recommended_wallet.annual_gain}/yr together`,
      );
    }
    for (const w of r.warnings) console.log(`warning: ${w}`);
  } finally {
    await db.end();
  }
}

async function runMisallocations(h: DbHandle) {
  const url = loadDbConfig().DATABASE_URL;
  const userId = await resolveUserId(h.db);
  const db = connectAgent(url, userId);
  try {
    const catalogs = await loadCatalogs(productTools());
    const day = today();
    const recorded = await refreshMisallocations(h.db, db, userId, catalogs, day);
    const drafted = await draftActions(
      h.db,
      userId,
      new Date(),
      await allocationNow(db),
      await readWorkplacePlans(db),
    );
    const r = await misallocationReport(db, catalogs, day);
    if (r.items.length === 0) console.log("Nothing found in the wrong place.");
    for (const m of r.items) {
      const tag = m.state === "dismissed" ? " (dismissed)" : "";
      console.log(`${m.annual_cost.padStart(10)}/yr  [${m.category}] ${m.summary}${tag}`);
      console.log(`              ${m.action} (${m.id})`);
    }
    console.log(
      `\nAbout ${r.annual_cost}/yr (${r.monthly_cost}/month) in all: ` +
        Object.entries(r.by_category)
          .map(([k, v]) => `${k} ${v}`)
          .join(", "),
    );
    const { totals } = await listMisallocations(db, { limit: 1 });
    if (totals && totals.resolved > 0) {
      console.log(
        `Acted on so far: ${totals.resolved}, worth ${totals.resolved_annual_cost}/yr estimated, ` +
          `${totals.realized_annual_value}/yr measured.`,
      );
    }
    console.log(
      `Recorded: ${recorded.found} new, ${recorded.resolved} resolved, ${recorded.withdrawn} withdrawn.`,
    );
    console.log(
      `Actions: ${drafted.drafted} drafted, ${drafted.confirmed} confirmed, ${drafted.withdrawn} withdrawn.`,
    );
    for (const n of r.not_covered) console.log(`not covered: ${n}`);
    for (const w of r.warnings) console.log(`warning: ${w}`);
  } finally {
    await db.end();
  }
}

async function runCardFor(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      merchant: { type: "string" },
      category: { type: "string" },
      amount: { type: "string" },
      foreign: { type: "boolean", default: false },
      card: { type: "string", multiple: true },
    },
  });
  const catalog = await loadCardCatalogFile(cardsPath());
  const url = loadDbConfig().DATABASE_URL;
  const db = connectAgent(url, await currentUser(url));
  try {
    const history =
      values.merchant && !values.category ? await merchantCategory(db, values.merchant) : null;
    const r = adviseOnPurchase(
      catalog,
      await readHeldCards(db),
      {
        amount: values.amount,
        category: values.category,
        merchant: values.merchant,
        foreign: values.foreign,
      },
      history,
      cardOverrides(values.card),
    );
    console.log(`${r.category_label} (${r.category_basis})`);
    for (const c of r.your_cards) {
      console.log(
        `  ${c.percent}%  ${c.card_name}` +
          (c.reward ? ` = ${c.reward}` : "") +
          (c.note ? ` (${c.note})` : ""),
      );
    }
    if (r.your_cards.length === 0) console.log("  no credit cards linked");
    const b = r.better_card_elsewhere;
    if (b)
      console.log(`A card you don't have would earn ${b.percent}%: ${b.name} (${b.source_url})`);
  } finally {
    await db.end();
  }
}

async function runImportCsv(h: DbHandle, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      institution: { type: "string" },
      account: { type: "string" },
      type: { type: "string" },
      subtype: { type: "string" },
      currency: { type: "string", default: "USD" },
      "date-col": { type: "string", default: "Date" },
      "amount-col": { type: "string", default: "Amount" },
      "desc-col": { type: "string", default: "Description" },
      "flip-sign": { type: "boolean", default: false },
      balance: { type: "string" },
    },
  });
  const [file] = positionals;
  if (!file || !values.institution || !values.account || !values.type) {
    throw new Error(`import-csv needs a file, --institution, --account and --type\n\n${USAGE}`);
  }
  const r = await importCsv(h.db, await readFile(file, "utf8"), {
    userId: await resolveUserId(h.db),
    institution: values.institution,
    account: values.account,
    type: values.type,
    ...(values.subtype ? { subtype: values.subtype } : {}),
    currency: values.currency,
    columns: {
      date: values["date-col"],
      amount: values["amount-col"],
      description: values["desc-col"],
    },
    flipSign: values["flip-sign"],
    ...(values.balance ? { balance: values.balance } : {}),
  });
  console.log(`imported ${r.inserted} new transactions (${r.skipped} already present)`);
}

async function runPlan(h: DbHandle, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "if-configured": { type: "boolean", default: false } },
  });
  const [sub, given] = positionals;
  if (sub === "set") {
    const file = given ?? planPath();
    if (!file) {
      if (values["if-configured"]) return;
      throw new Error("usage: tidysum plan set <file> (or set TIDYSUM_PLAN_FILE)");
    }
    await setPlanFile(h.db, await resolveUserId(h.db), file);
    console.log(`plan saved from ${file}`);
    return;
  }
  if (sub === "show") {
    const [row] = await h.db
      .select({ markdown: financialPlan.markdown })
      .from(financialPlan)
      .where(eq(financialPlan.userId, await resolveUserId(h.db)));
    console.log(row ? row.markdown : "no plan set; run `tidysum plan set <file>`");
    return;
  }
  throw new Error(
    `usage: tidysum plan set [file] [--if-configured] | tidysum plan show\n\n${USAGE}`,
  );
}

async function runWorkplace(h: DbHandle, args: string[]) {
  const [sub, accountId, file] = args;
  const userId = await resolveUserId(h.db);
  if (sub === "set" && accountId && file) {
    const facts = await setWorkplacePlan(
      h.db,
      userId,
      accountId,
      JSON.parse(await readFile(file, "utf8")),
    );
    console.log(`recorded ${facts.plan_name} as of ${facts.as_of}`);
    return;
  }
  if (sub === "show") {
    const rows = await h.db
      .select({
        accountId: workplacePlan.accountId,
        asOf: workplacePlan.asOf,
        facts: workplacePlan.facts,
      })
      .from(workplacePlan)
      .where(eq(workplacePlan.userId, userId));
    if (rows.length === 0) console.log("no workplace plan recorded");
    for (const r of rows) {
      const name = (r.facts as { plan_name?: string }).plan_name ?? "?";
      console.log(`${r.accountId}  ${name}  as of ${r.asOf}`);
    }
    return;
  }
  throw new Error(
    `usage: tidysum workplace set <account_id> <file> | tidysum workplace show\n\n${USAGE}`,
  );
}

async function runIra(h: DbHandle, args: string[]) {
  const [sub, file] = args;
  const userId = await resolveUserId(h.db);
  if (sub === "set" && file) {
    const facts = await setIraYear(h.db, userId, JSON.parse(await readFile(file, "utf8")));
    console.log(`recorded IRA contributions for ${facts.tax_year} as of ${facts.as_of}`);
    return;
  }
  if (sub === "show") {
    const rows = await h.db
      .select({ taxYear: iraYear.taxYear, asOf: iraYear.asOf, facts: iraYear.facts })
      .from(iraYear)
      .where(eq(iraYear.userId, userId))
      .orderBy(iraYear.taxYear);
    if (rows.length === 0) console.log("no IRA years recorded");
    for (const r of rows) console.log(`${r.taxYear}  as of ${r.asOf}  ${JSON.stringify(r.facts)}`);
    return;
  }
  throw new Error(`usage: tidysum ira set <file> | tidysum ira show\n\n${USAGE}`);
}

async function runPolicy(h: DbHandle, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "if-missing": { type: "boolean", default: false } },
  });
  const [sub, file] = positionals;
  const userId = await resolveUserId(h.db);
  if (sub === "set" && file) {
    if (values["if-missing"]) {
      const [existing] = await h.db
        .select({ id: policyVersion.id })
        .from(policyVersion)
        .where(eq(policyVersion.userId, userId))
        .limit(1);
      if (existing) {
        console.log("policy already set; leaving it");
        return;
      }
    }
    const loaded = await loadPolicyFile(file);
    await activatePolicy(h.db, userId, loaded);
    console.log(`active policy ${loaded.versionId.slice(0, 12)}`);
    return;
  }
  if (sub === "show") {
    const [row] = await h.db
      .select()
      .from(policyVersion)
      .where(eq(policyVersion.userId, userId))
      .orderBy(desc(policyVersion.activatedAt))
      .limit(1);
    if (!row) throw new Error("no policy set; run `tidysum policy set <file>`");
    console.log(`policy ${row.id.slice(0, 12)}, activated ${row.activatedAt.toISOString()}`);
    console.log(JSON.stringify(row.content, null, 2));
    return;
  }
  throw new Error(
    `usage: tidysum policy set <file> [--if-missing] | tidysum policy show\n\n${USAGE}`,
  );
}

async function status(h: DbHandle) {
  const userId = await resolveUserId(h.db);
  const items = await h.db
    .select()
    .from(item)
    .where(eq(item.userId, userId))
    .orderBy(item.createdAt);
  for (const it of items) {
    const [lastRun] = await h.db
      .select()
      .from(syncRun)
      .where(eq(syncRun.itemId, it.id))
      .orderBy(desc(syncRun.startedAt))
      .limit(1);
    console.log(
      `${it.institutionName ?? it.id} [${it.status}${it.statusDetail ? `: ${it.statusDetail}` : ""}]` +
        ` last sync ${it.lastSyncedAt?.toISOString() ?? "never"}` +
        (lastRun ? ` (last run ${lastRun.status})` : ""),
    );
    const accounts = await h.db.select().from(account).where(eq(account.itemId, it.id));
    for (const a of accounts) {
      const [bal] = await h.db
        .select()
        .from(balanceSnapshot)
        .where(eq(balanceSnapshot.accountId, a.id))
        .orderBy(desc(balanceSnapshot.asOf))
        .limit(1);
      const mask = a.mask ? ` ••${a.mask}` : "";
      console.log(
        `  ${a.name}${mask} (${a.type}/${a.subtype ?? "-"}): ${bal?.current ?? "?"} ${a.currency ?? ""}`,
      );
    }
  }
}

async function main(argv: string[]) {
  const [command, arg] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "agent" && arg === "setup") {
    for (const line of await setupAgent({ dryRun: argv.includes("--dry-run") })) console.log(line);
    return;
  }
  // These connect as the agent roles, not as the owner.
  if (command === "mcp") return runMcp();
  if (command === "check") return runCheck();
  if (command === "proposals") return runProposals();
  if (command === "allocation") return runAllocation();
  if (command === "research" && arg !== "import") return runResearch();
  if (command === "products") return runProducts();
  if (command === "cash-history") return runCashHistory();
  if (command === "cards") return runCards(argv.slice(1));
  if (command === "card-for") return runCardFor(argv.slice(1));
  const h = connect(loadDbConfig().DATABASE_URL);
  try {
    switch (command) {
      case "migrate":
        await runMigrations(h.db);
        console.log("migrations applied");
        break;
      case "link-sandbox": {
        const { plaid, cipher } = plaidDeps();
        const publicToken = await plaid.createSandboxPublicToken(
          arg ?? "ins_109508",
          DAYS_REQUESTED,
        );
        const id = await linkItem(h.db, plaid, cipher, await resolveUserId(h.db), publicToken);
        console.log(`linked sandbox item ${id}`);
        break;
      }
      case "sync":
        await syncAll(h);
        break;
      case "serve":
        await runServer(h);
        break;
      case "import-csv":
        await runImportCsv(h, argv.slice(1));
        break;
      case "misallocations":
        await runMisallocations(h);
        break;
      case "misallocation": {
        const id = argv[2];
        if ((arg !== "dismiss" && arg !== "undismiss") || !id)
          throw new Error(`usage: tidysum misallocation dismiss|undismiss <id>\n\n${USAGE}`);
        const ok = await setMisallocationState(
          h.db,
          await resolveUserId(h.db),
          id,
          arg === "dismiss" ? "dismissed" : "open",
          "cli",
        );
        console.log(
          ok ? `${arg}ed` : `no ${arg === "dismiss" ? "open" : "dismissed"} finding ${id}`,
        );
        break;
      }
      case "card-set": {
        const [, accountId, cardId] = argv;
        if (!accountId || !cardId)
          throw new Error(`card-set needs an account id and card id\n\n${USAGE}`);
        const catalog = await loadCardCatalogFile(cardsPath());
        await setCardAssignment(
          h.db,
          catalog,
          await resolveUserId(h.db),
          accountId,
          cardId === "none" ? null : cardId,
        );
        console.log(cardId === "none" ? "cleared" : `${accountId} is now ${cardId}`);
        break;
      }
      case "status":
        await status(h);
        break;
      case "item": {
        const id = argv[2];
        if (arg !== "remove" || !id)
          throw new Error(`usage: tidysum item remove <item_id>\n\n${USAGE}`);
        const { plaid, cipher } = plaidDeps();
        const r = await removeItem(h.db, plaid, cipher, await resolveUserId(h.db), id, "cli");
        console.log(
          `removed ${r.institution_name ?? id}: ${r.accounts} account(s), ` +
            `${r.proposals_deleted} proposal(s) that named them, ${r.findings_withdrawn} finding(s) withdrawn`,
        );
        break;
      }
      case "policy":
        await runPolicy(h, argv.slice(1));
        break;
      case "plan":
        await runPlan(h, argv.slice(1));
        break;
      case "workplace":
        await runWorkplace(h, argv.slice(1));
        break;
      case "actions":
        await runActions(h);
        break;
      case "action": {
        const file = argv[2];
        if (arg !== "schedule" || !file)
          throw new Error(`usage: tidysum action schedule <file>\n\n${USAGE}`);
        const r = await scheduleAction(
          h.db,
          await resolveUserId(h.db),
          parseSchedule(JSON.parse(await readFile(file, "utf8"))),
          "owner",
          today(),
        );
        console.log(
          `scheduled ${r.id}: ${r.not_before ? `from ${r.not_before}` : ""}${r.not_before && r.due_by ? ", " : ""}${r.due_by ? `due by ${r.due_by}` : ""}. ${r.next}`,
        );
        break;
      }
      case "due":
        await runDue(h);
        break;
      case "ira":
        await runIra(h, argv.slice(1));
        break;
      case "research": {
        const dir = minerDir();
        if (!dir) throw new Error("set TIDYSUM_MINER_DIR to investment-miner's directory");
        if (argv[1] === "scan") {
          const product = argv[2] === "assets" ? "assets" : "institutional";
          const scanner = new ResearchScanner(
            httpMinerApi(minerUrl(), () => readMinerPassword(dir)),
            async () => {
              const r = await importResearch(h.db, cliMinerSource(dir));
              console.log(r.imported.length ? `imported ${r.imported.join(", ")}` : "nothing new");
              if (!r.ok) console.error(r.error);
            },
            5_000,
          );
          const started = await scanner.start(product);
          if (started.state === "unavailable") throw new Error(started.reason);
          console.log(`investment-miner is scanning the ${product} watchlists; waiting…`);
          await scanner.settled();
          const after = await scanner.status();
          if (after.state === "idle" && after.last?.status === "failed") {
            console.error(`the scan failed: ${after.last.error ?? "no reason given"}`);
            process.exitCode = 1;
          }
          break;
        }
        const r = await importResearch(h.db, cliMinerSource(dir));
        for (const a of r.attempts) {
          const used = a.current ? `using ${a.current}` : "no current run";
          console.log(
            `${a.watchlist}: newest ${a.newest.run_id} (${a.newest.status}), ${used}${a.error ? `: ${a.error}` : ""}`,
          );
        }
        console.log(r.imported.length ? `imported ${r.imported.join(", ")}` : "nothing new");
        if (!r.ok) {
          console.error(r.error);
          process.exitCode = 1;
        }
        break;
      }
      case "manual": {
        const { values, positionals } = parseArgs({
          args: argv.slice(1),
          allowPositionals: true,
          options: {
            class: { type: "string" },
            value: { type: "string" },
            "as-of": { type: "string" },
          },
        });
        const [sub, name] = positionals;
        const userId = await resolveUserId(h.db);
        if (sub === "set" && name && values.class && values.value) {
          await setManualHolding(h.db, await loadSecurityCatalogFile(securitiesPath()), userId, {
            name,
            assetClass: values.class,
            value: values.value,
            asOf: values["as-of"] ?? today(),
          });
          console.log(`saved ${name}`);
        } else if (sub === "remove" && name) {
          console.log((await removeManualHolding(h.db, userId, name)) ? "removed" : "not found");
        } else if (sub === "list") {
          for (const m of await listManualHoldings(h.db, userId)) {
            console.log(`${m.name}  ${m.assetClass}  as of ${m.asOf}`);
          }
        } else {
          throw new Error(
            `usage: tidysum manual set <name> --class <class> --value <n> [--as-of <date>] | manual remove <name> | manual list\n\n${USAGE}`,
          );
        }
        break;
      }
      case "users":
        for (const u of await h.db.select().from(appUser).orderBy(appUser.createdAt)) {
          console.log(`${u.id}  ${u.displayName}${u.investingEnabled ? "  (investing)" : ""}`);
        }
        break;
      case "user": {
        const { values, positionals } = parseArgs({
          args: argv.slice(1),
          allowPositionals: true,
          options: {
            investing: { type: "boolean", default: false },
            yes: { type: "boolean", default: false },
          },
        });
        const [sub, name] = positionals;
        if (sub === "delete" && name) {
          if (!values.yes) throw new Error("this deletes all of the user's data; pass --yes");
          const { plaid, cipher } = plaidDeps();
          const r = await deleteUser(h.db, plaid, cipher, name, "cli");
          console.log(`deleted user ${name} and ${r.items} Item(s); the audit log is kept`);
          break;
        }
        if (sub !== "add" || !name) {
          throw new Error(
            `usage: tidysum user add <name> [--investing] | user delete <user_id> --yes\n\n${USAGE}`,
          );
        }
        console.log(await createUser(h.db, name, values.investing));
        break;
      }
      default:
        console.error(`unknown command: ${command}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    await h.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
