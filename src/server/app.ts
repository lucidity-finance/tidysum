import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  decideAction,
  draftActions,
  listActions,
  listActivity,
  setActionOrder,
  settleFinished,
} from "../actions/actions.js";
import { isLoopbackHost } from "../config.js";
import type { TokenCipher } from "../crypto/tokenCipher.js";
import type { Db } from "../db/client.js";
import { item } from "../db/schema.js";
import { removeItem } from "../exits.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { createTidysumMcpServer, type PolicyTools, type ProductTools } from "../mcp/server.js";
import { loadCatalogs, misallocationReport } from "../misallocation/detect.js";
import {
  listMisallocations,
  refreshMisallocations,
  setMisallocationState,
} from "../misallocation/ledger.js";
import type { PlaidGateway } from "../plaid/gateway.js";
import { handlePlaidWebhook } from "../plaid/webhooks.js";
import { type PlaidWebhookVerifier, WebhookVerificationError } from "../plaid/webhookVerifier.js";
import { planForPage, readPlan } from "../plan/plan.js";
import { STYLE_IDS } from "../policy/policy.js";
import { approveProposal, listProposals } from "../policy/proposals.js";
import { readOwnerPolicy, setStyle } from "../policy/store.js";
import { listStyles } from "../policy/styles.js";
import { allocationForPage, readAllocation } from "../portfolio/allocation.js";
import { setCardAssignment } from "../products/cardAssignments.js";
import {
  compareCards,
  readCardFees,
  readHeldCards,
  readPaidMemberships,
  readSpending,
  totalInterest,
} from "../products/cards.js";
import { readCashHistoryReport } from "../products/cashHistory.js";
import { readAndCompare } from "../products/compare.js";
import { setDepositChoice } from "../products/depositChoices.js";
import { readResearchReport, researchForPage } from "../research/report.js";
import type { ResearchScanner } from "../research/scan.js";
import { ensurePlaidUser, linkItem, loadAccessToken } from "../sync/items.js";
import type { SyncScheduler } from "../sync/scheduler.js";
import { normalizePhone, readPhone, setPhone } from "../users.js";
import { APP_CSS, APP_JS, FAVICON_SVG, INDEX_HTML, SERIF_WOFF2 } from "./page.js";

export interface AppDeps {
  db: Db;
  plaid: PlaidGateway;
  cipher: TokenCipher;
  scheduler: SyncScheduler;
  verifier: PlaidWebhookVerifier;
  /**
   * HTTP Basic password for everything except the webhook and health endpoints. Undefined
   * means the server listens on loopback only and the admin page needs no sign-in; requests
   * must then name a loopback host, so a web page can't reach it by DNS rebinding.
   */
  adminToken?: string;
  /** Where Plaid should send webhooks, or undefined to not register one. */
  webhookUrl?: string;
  daysRequested: number;
  /** Wait between /link/token/get retries while a finished session's results appear; 0 = no retry. */
  linkSessionRetryMs?: number;
  /**
   * The user this admin page and /mcp act for. One admin token maps to one user; per-user
   * sign-in is the seam for a hosted, multi-user Tidysum.
   */
  userId: string;
  /** tidysum_agent pool for `userId`, for read-only views and the MCP endpoint. */
  agentDb: AgentDb;
  /** Starts investment-miner scans and imports what they produce; unset when it isn't set up. */
  research?: Pick<ResearchScanner, "start" | "status">;
  /** Serve the agent MCP endpoint at /mcp, behind its own bearer token. */
  mcp?: { token: string; policy?: PolicyTools; products?: ProductTools };
  /** Product catalog for the "better accounts" view; omitted means no such view. */
  products?: ProductTools;
  /**
   * `tidysum demo`: the data is a made-up household. The page says so, and linking or removing
   * institutions is refused, so the demo is never mixed with real accounts.
   */
  demo?: boolean;
}

const LinkTokenBody = z.object({ itemId: z.uuid().optional() }).strict();
const LinkSessionBody = z.object({ linkToken: z.string().min(1).max(200) }).strict();
const DepositChoiceBody = z
  .object({
    productId: z
      .string()
      .regex(/^[a-z0-9-]{1,60}$/)
      .nullable(),
  })
  .strict();

const StyleBody = z
  .object({
    id: z.enum(STYLE_IDS),
    age: z.number().int().min(18).max(90).optional(),
    /** Only say what would change. */
    dryRun: z.boolean().optional(),
  })
  .strict();

const CardAssignmentBody = z
  .object({
    cardId: z
      .string()
      .regex(/^[a-z0-9-]{1,60}$/)
      .nullable(),
  })
  .strict();
const PhoneBody = z.object({ phone: z.string().max(40).nullable() }).strict();
const ExchangeBody = z.object({ publicToken: z.string().min(1).max(200) }).strict();
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function passwordMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return secretMatches(decoded.slice(decoded.indexOf(":") + 1), expected);
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  return !!header?.startsWith("Bearer ") && secretMatches(header.slice(7), expected);
}

export function createApp(deps: AppDeps) {
  const today = (deps.products?.today ??
    deps.mcp?.policy?.today ??
    (() => new Date().toISOString().slice(0, 10))) as () => string;
  const app = new Hono();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.plaid.com"],
        frameSrc: ["https://cdn.plaid.com"],
        connectSrc: ["'self'", "https://*.plaid.com"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );

  app.get("/healthz", (c) => c.text("ok"));

  // Plaid authenticates itself with a signed JWT, not the admin password.
  app.post("/webhooks/plaid", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const raw = await c.req.text();
    try {
      await deps.verifier.verify(c.req.header("Plaid-Verification"), raw);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        console.warn(`rejected Plaid webhook: ${err.message}`);
        return c.text("unauthorized", 401);
      }
      throw err;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad request", 400);
    }
    const outcome = await handlePlaidWebhook(deps.db, body, (id) => {
      void deps.scheduler.request(id);
    });
    return c.json({ outcome });
  });

  // Agents authenticate with their own token, so a leaked agent config can't reach the admin
  // page, and the admin password never sits in an agent's config. Stateless: a fresh server
  // per request, JSON responses only.
  const mcp = deps.mcp;
  if (mcp) {
    app.all("/mcp", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
      if (!bearerMatches(c.req.header("Authorization"), mcp.token)) {
        c.header("WWW-Authenticate", 'Bearer realm="Tidysum MCP"');
        return c.text("unauthorized", 401);
      }
      const server = createTidysumMcpServer(deps.agentDb, mcp.policy, mcp.products);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        await server.close();
      }
    });
  }

  // Everything below needs the admin password, or, without one, a loopback Host header.
  const adminToken = deps.adminToken;
  app.use("*", async (c, next) => {
    if (adminToken === undefined) {
      if (!isLoopbackHost(new URL(c.req.url).hostname)) return c.text("forbidden", 403);
    } else if (!passwordMatches(c.req.header("Authorization"), adminToken)) {
      c.header("WWW-Authenticate", 'Basic realm="Tidysum", charset="UTF-8"');
      return c.text("unauthorized", 401);
    }
    await next();
  });
  app.use("/api/*", csrf(), bodyLimit({ maxSize: 16 * 1024 }));

  if (deps.demo) {
    const refuse = (c: Context) =>
      c.json(
        { error: "This is the demo with a made-up household; it can't connect real accounts." },
        403,
      );
    for (const path of ["/api/phone", "/api/link-token", "/api/link-sessions", "/api/items"]) {
      app.post(path, refuse);
    }
    app.post("/api/items/:id/*", refuse);
  }

  app.get("/", (c) => c.html(INDEX_HTML));
  app.get("/app.js", (c) => c.body(APP_JS, 200, { "Content-Type": "text/javascript" }));
  app.get("/app.css", (c) => c.body(APP_CSS, 200, { "Content-Type": "text/css" }));
  app.get("/favicon.svg", (c) => c.body(FAVICON_SVG, 200, { "Content-Type": "image/svg+xml" }));
  app.get("/source-serif-4.woff2", (c) =>
    c.body(SERIF_WOFF2, 200, {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=604800",
    }),
  );

  app.get("/api/items", async (c) => {
    const rows = await deps.db
      .select({
        id: item.id,
        source: item.source,
        institutionName: item.institutionName,
        status: item.status,
        statusDetail: item.statusDetail,
        lastSyncedAt: item.lastSyncedAt,
      })
      .from(item)
      .where(eq(item.userId, deps.userId))
      .orderBy(item.createdAt);
    // Only the last digits go back to the page: enough to recognise the number.
    const phone = await readPhone(deps.db, deps.userId);
    return c.json({
      items: rows,
      phoneEnding: phone ? phone.slice(-4) : null,
      ...(deps.demo ? { demo: true } : {}),
    });
  });

  // The number Plaid Link pre-fills, so linking asks only for the texted code.
  app.post("/api/phone", async (c) => {
    const body = PhoneBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    if (body.data.phone === null) {
      await setPhone(deps.db, deps.userId, null);
      return c.json({ phoneEnding: null });
    }
    const phone = normalizePhone(body.data.phone);
    if (!phone) return c.json({ error: "That isn't a phone number Plaid can use." }, 400);
    await setPhone(deps.db, deps.userId, phone);
    return c.json({ phoneEnding: phone.slice(-4) });
  });

  app.post("/api/link-token", async (c) => {
    const body = LinkTokenBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    let accessToken: string | undefined;
    if (body.data.itemId) {
      const [row] = await deps.db
        .select()
        .from(item)
        .where(and(eq(item.id, body.data.itemId), eq(item.userId, deps.userId)));
      if (row?.source !== "plaid") return c.json({ error: "unknown item" }, 404);
      accessToken = await loadAccessToken(deps.db, deps.cipher, row.id);
    }
    // New links add as many institutions as the user wants in one session (one phone code).
    const plaidUserId = accessToken
      ? undefined
      : await ensurePlaidUser(deps.db, deps.plaid, deps.userId);
    const phoneNumber = await readPhone(deps.db, deps.userId);
    const linkToken = await deps.plaid.createLinkToken({
      clientUserId: deps.userId,
      ...(accessToken ? { accessToken } : {}),
      ...(plaidUserId ? { plaidUserId } : {}),
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(deps.webhookUrl ? { webhookUrl: deps.webhookUrl } : {}),
      daysRequested: deps.daysRequested,
    });
    console.log(
      `link token: ${accessToken ? "repair" : plaidUserId ? "several institutions" : "one institution"}` +
        `${phoneNumber ? ", phone pre-filled" : ""}`,
    );
    return c.json({ linkToken, multi: plaidUserId !== undefined });
  });

  // Called by the page when a Multi-Item Link session hands off: store every Item it added.
  // Public tokens are single-use, so a repeat call finds them spent and reports the failures.
  app.post("/api/link-sessions", async (c) => {
    const body = LinkSessionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    // Link hands off as the session ends; its results can take a moment to appear.
    let publicTokens: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      publicTokens = await deps.plaid.getLinkSessionPublicTokens(body.data.linkToken);
      if (publicTokens.length || !deps.linkSessionRetryMs) break;
      await new Promise((r) => setTimeout(r, deps.linkSessionRetryMs));
    }
    const itemIds: string[] = [];
    const errors: string[] = [];
    for (const publicToken of publicTokens) {
      try {
        const itemId = await linkItem(deps.db, deps.plaid, deps.cipher, deps.userId, publicToken);
        itemIds.push(itemId);
        void deps.scheduler.request(itemId);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    // Enough to tell later whether a session added several institutions or just one.
    console.log(
      `link session: ${publicTokens.length} added, ${itemIds.length} saved, ${errors.length} failed`,
    );
    return c.json({ itemIds, errors }, itemIds.length ? 201 : 200);
  });

  app.post("/api/items", async (c) => {
    const body = ExchangeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const itemId = await linkItem(
      deps.db,
      deps.plaid,
      deps.cipher,
      deps.userId,
      body.data.publicToken,
    );
    void deps.scheduler.request(itemId);
    return c.json({ itemId }, 201);
  });

  // Called by the page after Link's update mode succeeds.
  app.post("/api/items/:id/repaired", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const updated = await deps.db
      .update(item)
      .set({ status: "active", statusDetail: null })
      .where(and(eq(item.id, id.data), eq(item.userId, deps.userId)))
      .returning({ id: item.id });
    if (updated.length === 0) return c.json({ error: "unknown item" }, 404);
    void deps.scheduler.request(id.data);
    return c.json({ ok: true });
  });

  // Disconnects an Item and deletes its data (decision 0002, principle 9).
  app.post("/api/items/:id/remove", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const [row] = await deps.db
      .select({ id: item.id })
      .from(item)
      .where(and(eq(item.id, id.data), eq(item.userId, deps.userId)));
    if (!row) return c.json({ error: "unknown item" }, 404);
    return c.json(await removeItem(deps.db, deps.plaid, deps.cipher, deps.userId, row.id, "admin"));
  });

  app.get("/api/proposals", async (c) => c.json(await listProposals(deps.agentDb, { limit: 50 })));
  app.get("/api/actions", async (c) => {
    // What the owner's agent finished shows as done at once, not after the next sync.
    await settleFinished(deps.db, deps.userId);
    return c.json(await listActions(deps.agentDb, today()));
  });
  // What Tidysum, the owner and their agent did lately, and whether an agent can connect over HTTP.
  app.get("/api/activity", async (c) =>
    c.json({ mcp: deps.mcp !== undefined, events: await listActivity(deps.agentDb) }),
  );

  // The owner's plan laid out as plain text runs, so the page never renders HTML from it.
  app.get("/api/plan", async (c) => c.json(planForPage(await readPlan(deps.agentDb))));

  app.get("/api/products", async (c) => {
    const products = deps.products;
    if (!products) return c.json({ error: "no product catalog configured" }, 404);
    const today = (products.today ?? (() => new Date().toISOString().slice(0, 10)))();
    return c.json(await readAndCompare(deps.agentDb, await products.loadCatalog(), today));
  });

  app.get("/api/cash-history", async (c) => {
    const products = deps.products;
    if (!products) return c.json({ error: "no product catalog configured" }, 404);
    const today = (products.today ?? (() => new Date().toISOString().slice(0, 10)))();
    return c.json(await readCashHistoryReport(deps.agentDb, await products.loadCatalog(), today));
  });

  // Percentages only, and only by bucket: no dollar amounts and no individual positions.
  app.get("/api/allocation", async (c) => {
    const products = deps.products;
    if (!products) return c.json({ error: "no product catalog configured" }, 404);
    const today = (products.today ?? (() => new Date().toISOString().slice(0, 10)))();
    return c.json(
      allocationForPage(
        await readAllocation(deps.agentDb, await products.loadSecurityCatalog?.(), today),
      ),
    );
  });

  // The research sleeve and investment-miner's candidates: percentages and evidence, no dollars.
  app.get("/api/research", async (c) => {
    const today = (deps.products?.today ?? (() => new Date().toISOString().slice(0, 10)))();
    const page = researchForPage(await readResearchReport(deps.agentDb, today));
    if (page.state === "off") return c.json(page);
    return c.json({ ...page, scan: deps.research ? await deps.research.status() : null });
  });

  // Asks investment-miner to scan now; Tidysum imports the result when the scan finishes.
  app.post("/api/research/scan", async (c) => {
    if (!deps.research) return c.json({ error: "investment-miner isn't set up" }, 404);
    const today = (deps.products?.today ?? (() => new Date().toISOString().slice(0, 10)))();
    const r = await readResearchReport(deps.agentDb, today, 1);
    if (r.state === "off") return c.json({ error: "investing is off for this user" }, 403);
    try {
      return c.json({ scan: await deps.research.start("institutional") });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.get("/api/cards", async (c) => {
    const loadCards = deps.products?.loadCardCatalog;
    if (!loadCards) return c.json({ error: "no card catalog configured" }, 404);
    const today = (deps.products?.today ?? (() => new Date().toISOString().slice(0, 10)))();
    const catalog = await loadCards();
    return c.json({
      ...compareCards(
        catalog,
        await readSpending(deps.agentDb, today),
        await readHeldCards(deps.agentDb),
        today,
        {},
        totalInterest(await readCardFees(deps.agentDb, today)),
        await readPaidMemberships(deps.agentDb, today),
      ),
      catalog_cards: catalog.cards.map((k) => ({
        id: k.id,
        name: k.name,
        issuer: k.issuer,
        kind: k.kind,
      })),
    });
  });

  app.get("/api/misallocations", async (c) => {
    const products = deps.products;
    if (!products) return c.json({ error: "no product catalog configured" }, 404);
    const today = (products.today ?? (() => new Date().toISOString().slice(0, 10)))();
    const [report, ledger] = await Promise.all([
      misallocationReport(deps.agentDb, await loadCatalogs(products), today),
      listMisallocations(deps.agentDb, { state: "resolved", limit: 20 }),
    ]);
    return c.json({ ...report, resolved: ledger.misallocations, totals: ledger.totals });
  });

  for (const [path, state] of [
    ["dismiss", "dismissed"],
    ["undismiss", "open"],
  ] as const) {
    app.post(`/api/misallocations/:id/${path}`, async (c) => {
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "invalid id" }, 400);
      const done = await setMisallocationState(deps.db, deps.userId, id.data, state, "admin");
      if (!done) return c.json({ error: "no such finding in that state" }, 404);
      // Its action follows at once: withdrawn when dismissed, drafted again when restored.
      await draftActions(deps.db, deps.userId);
      return c.json({ ok: true });
    });
  }

  // The user says which catalog card a linked card is (or clears it with null).
  app.post("/api/cards/:accountId", async (c) => {
    const loadCards = deps.products?.loadCardCatalog;
    if (!loadCards) return c.json({ error: "no card catalog configured" }, 404);
    const id = z.uuid().safeParse(c.req.param("accountId"));
    const body = CardAssignmentBody.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: "invalid request" }, 400);
    try {
      await setCardAssignment(deps.db, await loadCards(), deps.userId, id.data, body.data.cardId);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  // The owner picks where a cash account's spare money goes (or clears it with null). The
  // finding and its action follow at once, so the card shows that bank's steps.
  app.post("/api/products/:accountId/choice", async (c) => {
    const products = deps.products;
    if (!products) return c.json({ error: "no product catalog configured" }, 404);
    const id = z.uuid().safeParse(c.req.param("accountId"));
    const body = DepositChoiceBody.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: "invalid request" }, 400);
    const catalogs = await loadCatalogs(products);
    if (!catalogs.deposits) return c.json({ error: "no deposit catalog configured" }, 404);
    try {
      await setDepositChoice(deps.db, catalogs.deposits, deps.userId, id.data, body.data.productId);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await refreshMisallocations(deps.db, deps.agentDb, deps.userId, catalogs, today());
    await draftActions(deps.db, deps.userId);
    return c.json({ ok: true });
  });

  // Money styles: every style and what picking it would change, for the Plan page.
  app.get("/api/styles", async (c) => {
    const raw = c.req.query("age");
    const age = raw && /^\d{2}$/.test(raw) ? Number(raw) : undefined;
    const current = await readOwnerPolicy(deps.db, deps.userId);
    return c.json(listStyles(current?.policy ?? null, { age }));
  });

  // The owner picks a money style: it fills the policy's rules, then findings and actions follow
  // at once, so the Actions page reflects the new rules.
  app.post("/api/policy/style", async (c) => {
    const body = StyleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const { id, age, dryRun } = body.data;
    let r: Awaited<ReturnType<typeof setStyle>>;
    try {
      r = await setStyle(deps.db, deps.userId, id, { age, dryRun });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (r.applied) {
      if (deps.products) {
        const catalogs = await loadCatalogs(deps.products);
        await refreshMisallocations(deps.db, deps.agentDb, deps.userId, catalogs, today());
      }
      await draftActions(deps.db, deps.userId);
    }
    return c.json({ ok: true, applied: r.applied, changes: r.changes });
  });

  // The owner's yes. Re-checked against the rules and today's data first; nothing executes.
  app.post("/api/proposals/:id/approve", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "invalid id" }, 400);
    const r = await approveProposal(deps.db, deps.agentDb, deps.userId, id.data, today(), "admin");
    if (r.approved) return c.json({ ok: true, validation: r.validation });
    if (r.reason === "not_open") return c.json({ error: "no open proposal with that id" }, 404);
    return c.json({ error: `Your rules block it now: ${r.validation.violations.join("; ")}` }, 409);
  });

  // The owner's other decisions on an action: done, not now, don't suggest again.
  for (const [path, decision] of [
    ["done", "done"],
    ["snooze", "snooze"],
    ["dismiss", "dismiss"],
  ] as const) {
    app.post(`/api/proposals/:id/${path}`, async (c) => {
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "invalid id" }, 400);
      const ok = await decideAction(deps.db, deps.userId, id.data, decision, "admin", today());
      if (!ok) return c.json({ error: "no action with that id in that state" }, 404);
      return c.json({ ok: true });
    });
  }

  // The owner's own order for a list of actions, dragged into place on the Actions page.
  app.post("/api/actions/order", async (c) => {
    const body = z
      .object({ ids: z.array(z.uuid()).min(1).max(200) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected { ids: [action ids] }" }, 400);
    return c.json({ placed: await setActionOrder(deps.db, deps.userId, body.data.ids) });
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
