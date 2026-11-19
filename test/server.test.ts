import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import { appUser, financialPlan, item, transaction } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { setPlan } from "../src/plan/plan.js";
import { createApp } from "../src/server/app.js";
import { linkItem } from "../src/sync/items.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { checking, FakePlaid, page, txn } from "./fakePlaid.js";
import { ownerUserId } from "./users.js";
import { webhookSigner } from "./webhookSigner.js";

const h = connect(inject("databaseUrl"));
const { db } = h;
const cipher = new TokenCipher(randomBytes(32).toString("base64"));
const ADMIN = "correct horse battery staple 0123456789";
const auth = { Authorization: `Basic ${Buffer.from(`owner:${ADMIN}`).toString("base64")}` };
const json = { ...auth, "Content-Type": "application/json", Origin: "http://localhost" };

const userId = await ownerUserId(db);
const agentDb = connectAgent(inject("databaseUrl"), userId);
afterAll(async () => {
  await agentDb.end();
  await h.close();
});
// Routes start syncs in the background; one still running when the next test truncates its
// tables deadlocks the TRUNCATE, so let every test's syncs finish first.
const schedulers: SyncScheduler[] = [];
beforeEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.idle()));
  await db.execute(sql`TRUNCATE item, security CASCADE`);
  await db.update(appUser).set({ plaidUserId: null, phoneNumber: null });
});

function setup({ open = false } = {}) {
  const plaid = new FakePlaid();
  plaid.accounts = [checking("100.00")];
  const signer = webhookSigner();
  plaid.webhookKeys.set(signer.kid, signer.key);
  const scheduler = new SyncScheduler(db, plaid, cipher);
  schedulers.push(scheduler);
  const app = createApp({
    db,
    plaid,
    cipher,
    scheduler,
    verifier: new PlaidWebhookVerifier(plaid),
    adminToken: open ? undefined : ADMIN,
    webhookUrl: "https://tidysum.example/webhooks/plaid",
    daysRequested: 730,
    userId,
    agentDb,
  });
  return { plaid, app, scheduler, signer };
}

describe("admin auth", () => {
  it("rejects requests without the admin password", async () => {
    const { app } = setup();
    for (const path of ["/", "/app.js", "/app.css", "/api/items"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
    }
    const wrong = { Authorization: `Basic ${Buffer.from("owner:nope").toString("base64")}` };
    expect((await app.request("/api/items", { headers: wrong })).status).toBe(401);
  });

  it("serves the page with a strict CSP when authenticated", async () => {
    const { app } = setup();
    const res = await app.request("/", { headers: auth });
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self' https://cdn.plaid.com");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("serves the research sleeve behind the admin password, with no dollar amounts", async () => {
    const { app } = setup();
    expect((await app.request("/api/research")).status).toBe(401);
    const body = (await (await app.request("/api/research", { headers: auth })).json()) as {
      note: string;
    };
    expect(body).toMatchObject({ state: "no_runs", lists: [], read: false, stale: true });
    expect(body.note).toMatch(/research evidence, not target weights/);
  });

  it("serves the owner's plan as blocks of text, behind the admin password", async () => {
    const { app } = setup();
    expect((await app.request("/api/plan")).status).toBe(401);
    expect(await (await app.request("/api/plan", { headers: auth })).json()).toEqual({
      state: "none",
    });
    await setPlan(db, userId, "# Plan\n\n- **Save** 20%");
    try {
      const body = await (await app.request("/api/plan", { headers: auth })).json();
      expect(body).toMatchObject({
        state: "ready",
        blocks: [
          { type: "heading", level: 1 },
          {
            type: "list",
            items: [[{ text: "Save", bold: true }, { text: " 20%" }]],
          },
        ],
      });
      expect(body).not.toHaveProperty("markdown");
    } finally {
      await db.delete(financialPlan);
    }
  });

  it("needs no password without an admin token, but only for a loopback Host", async () => {
    const { app } = setup({ open: true });
    for (const host of ["localhost", "127.0.0.1:8080", "[::1]:8080"]) {
      const res = await app.request(`http://${host}/api/items`);
      expect(res.status, host).toBe(200);
    }
    // A DNS-rebinding page reaches 127.0.0.1 under its own name; refuse it.
    const rebound = await app.request("http://evil.example/api/items");
    expect(rebound.status).toBe(403);
    const post = await app.request("http://127.0.0.1:8080/api/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:8080" },
      body: "{}",
    });
    expect(post.status).toBe(200);
  });

  it("leaves the health check open", async () => {
    const { app } = setup();
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("linking", () => {
  it("creates a multi-institution Link token with max history and the webhook URL", async () => {
    const { app, plaid } = setup();
    const res = await app.request("/api/link-token", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linkToken: "link-token-1", multi: true });
    expect(plaid.linkTokenRequests).toEqual([
      {
        webhookUrl: "https://tidysum.example/webhooks/plaid",
        daysRequested: 730,
        clientUserId: userId,
        plaidUserId: "plaid-user-1",
      },
    ]);
    // The Plaid user is created once and reused.
    await app.request("/api/link-token", { method: "POST", headers: json, body: "{}" });
    expect(plaid.createdUsers).toEqual([userId]);
    expect(plaid.linkTokenRequests[1]?.plaidUserId).toBe("plaid-user-1");
  });

  it("saves a phone number for Link to pre-fill and shows only its last digits", async () => {
    const { app, plaid } = setup();
    const save = (phone: string | null) =>
      app.request("/api/phone", { method: "POST", headers: json, body: JSON.stringify({ phone }) });
    expect((await save("12345")).status).toBe(400);
    const saved = await save("(415) 555-0123");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ phoneEnding: "0123" });
    const items = (await (await app.request("/api/items", { headers: auth })).json()) as {
      phoneEnding: string | null;
    };
    expect(items.phoneEnding).toBe("0123");
    expect(JSON.stringify(items)).not.toContain("415");

    await app.request("/api/link-token", { method: "POST", headers: json, body: "{}" });
    expect(plaid.linkTokenRequests[0]?.phoneNumber).toBe("+14155550123");

    expect(await (await save(null)).json()).toEqual({ phoneEnding: null });
    await app.request("/api/link-token", { method: "POST", headers: json, body: "{}" });
    expect(plaid.linkTokenRequests[1]?.phoneNumber).toBeUndefined();
  });

  it("falls back to one institution per session when Plaid has no user for us", async () => {
    const { app, plaid } = setup();
    plaid.userCreateError = new Error("user APIs not enabled");
    const res = await app.request("/api/link-token", { method: "POST", headers: json, body: "{}" });
    expect(await res.json()).toEqual({ linkToken: "link-token-1", multi: false });
    expect(plaid.linkTokenRequests[0]?.plaidUserId).toBeUndefined();
  });

  it("stores every institution a Link session added", async () => {
    const { app, plaid, scheduler } = setup();
    plaid.linkSessionTokens.set("link-token-9", ["public-a", "public-b"]);
    const post = () =>
      app.request("/api/link-sessions", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ linkToken: "link-token-9" }),
      });
    const res = await post();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { itemIds: string[]; errors: string[] };
    expect(body.itemIds).toHaveLength(2);
    expect(body.errors).toEqual([]);
    await scheduler.idle();
    const rows = await db.select().from(item);
    expect(rows.map((r) => r.plaidItemId).sort()).toEqual(["plaid-public-a", "plaid-public-b"]);
    expect(rows.every((r) => r.userId === userId)).toBe(true);
    // Calling again doesn't duplicate anything.
    await post();
    expect(await db.select().from(item)).toHaveLength(2);
  });

  it("exchanges a public token, stores the item and syncs it", async () => {
    const { app, plaid, scheduler } = setup();
    plaid.onSync(null, page({ added: [txn("t1", "5.00")], nextCursor: "c1" }));
    const res = await app.request("/api/items", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ publicToken: "public-abc" }),
    });
    expect(res.status).toBe(201);
    await scheduler.idle();
    expect(await db.select().from(transaction)).toHaveLength(1);
  });

  it("removes an item: revoked at Plaid, gone from the list", async () => {
    const { app, plaid } = setup();
    const itemId = await linkItem(db, plaid, cipher, userId, "public-rm");
    const remove = (id: string) =>
      app.request(`/api/items/${id}/remove`, { method: "POST", headers: json, body: "{}" });
    const res = await remove(itemId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accounts: 0, proposals_deleted: 0 });
    expect(plaid.removed).toEqual(["access-public-rm"]);
    expect(await db.select().from(item).where(eq(item.id, itemId))).toEqual([]);
    expect((await remove(itemId)).status).toBe(404);
  });

  it("opens update mode with the item's own token for a broken item", async () => {
    const { app, plaid } = setup();
    const itemId = await linkItem(db, plaid, cipher, userId, "public-1");
    const res = await app.request("/api/link-token", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ itemId }),
    });
    expect(res.status).toBe(200);
    expect(plaid.linkTokenRequests[0]?.accessToken).toBe("access-public-1");
  });

  it("rejects cross-site form posts", async () => {
    const { app } = setup();
    const res = await app.request("/api/items", {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
      body: "publicToken=x",
    });
    expect(res.status).toBe(403);
  });
});

describe("action order", () => {
  it("keeps the order the owner drags actions into, and refuses anything but action ids", async () => {
    const { app } = setup();
    const order = (body: unknown) =>
      app.request("/api/actions/order", {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await order({ ids: ["not-an-id"] })).status).toBe(400);
    expect((await order({ ids: [] })).status).toBe(400);
    // An id that isn't one of the owner's open actions places nothing.
    const res = await order({ ids: [crypto.randomUUID()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ placed: 0 });
  });
});

describe("Plaid webhooks", () => {
  async function post(app: ReturnType<typeof setup>["app"], body: object, jwt?: string) {
    const raw = JSON.stringify(body);
    return app.request("/webhooks/plaid", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jwt ? { "Plaid-Verification": jwt } : {}),
      },
      body: raw,
    });
  }

  it("rejects unsigned webhooks without touching the item", async () => {
    const { app, plaid } = setup();
    const itemId = await linkItem(db, plaid, cipher, userId, "public-1");
    const res = await post(app, {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "plaid-item-1",
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    });
    expect(res.status).toBe(401);
    const [row] = await db.select().from(item).where(eq(item.id, itemId));
    expect(row?.status).toBe("active");
  });

  it("marks an item for re-link on a signed ITEM_LOGIN_REQUIRED error", async () => {
    const { app, plaid, signer } = setup();
    const itemId = await linkItem(db, plaid, cipher, userId, "public-1");
    const body = {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "plaid-item-1",
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    };
    const res = await post(
      app,
      body,
      signer.signJwt(JSON.stringify(body), { iat: Math.floor(Date.now() / 1000) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "status_updated" });
    const [row] = await db.select().from(item).where(eq(item.id, itemId));
    expect(row).toMatchObject({ status: "relink_required", statusDetail: "ITEM_LOGIN_REQUIRED" });
  });

  it("syncs on SYNC_UPDATES_AVAILABLE", async () => {
    const { app, plaid, signer, scheduler } = setup();
    await linkItem(db, plaid, cipher, userId, "public-1");
    plaid.onSync(null, page({ added: [txn("t1", "5.00")], nextCursor: "c1" }));
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "plaid-item-1",
    };
    const res = await post(
      app,
      body,
      signer.signJwt(JSON.stringify(body), { iat: Math.floor(Date.now() / 1000) }),
    );
    expect(await res.json()).toEqual({ outcome: "sync_requested" });
    await scheduler.idle();
    expect(await db.select().from(transaction)).toHaveLength(1);
  });

  it("ignores webhooks for unknown items", async () => {
    const { app, signer } = setup();
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "nope",
    };
    const res = await post(
      app,
      body,
      signer.signJwt(JSON.stringify(body), { iat: Math.floor(Date.now() / 1000) }),
    );
    expect(await res.json()).toEqual({ outcome: "ignored" });
  });
});
