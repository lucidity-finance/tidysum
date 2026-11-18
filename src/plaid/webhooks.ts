import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { item } from "../db/schema.js";
import { RELINK_ERROR_CODES } from "./gateway.js";

const Webhook = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string().optional(),
  error: z.object({ error_code: z.string() }).nullish(),
});

const RELINK_ITEM_CODES = new Set([
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "USER_PERMISSION_REVOKED",
  "USER_ACCOUNT_REVOKED",
]);

const SYNC_TRIGGERS = new Set([
  "TRANSACTIONS:SYNC_UPDATES_AVAILABLE",
  "HOLDINGS:DEFAULT_UPDATE",
  "INVESTMENTS_TRANSACTIONS:DEFAULT_UPDATE",
  "LIABILITIES:DEFAULT_UPDATE",
  "ITEM:LOGIN_REPAIRED",
]);

export type WebhookOutcome = "ignored" | "status_updated" | "sync_requested";

/**
 * Apply a verified Plaid webhook. The body must already have passed PlaidWebhookVerifier;
 * its fields are still only data (an error code, an item id), never acted on beyond these rules.
 */
export async function handlePlaidWebhook(
  db: Db,
  body: unknown,
  requestSync: (itemId: string) => void,
): Promise<WebhookOutcome> {
  const parsed = Webhook.safeParse(body);
  if (!parsed.success || !parsed.data.item_id) return "ignored";
  const w = parsed.data;
  const [row] = await db
    .select({ id: item.id })
    .from(item)
    .where(eq(item.plaidItemId, w.item_id as string));
  if (!row) return "ignored";

  const key = `${w.webhook_type}:${w.webhook_code}`;
  if (w.webhook_type === "ITEM" && w.webhook_code === "ERROR" && w.error) {
    const code = w.error.error_code;
    await db
      .update(item)
      .set({
        status: RELINK_ERROR_CODES.has(code) ? "relink_required" : "error",
        statusDetail: code,
      })
      .where(eq(item.id, row.id));
    return "status_updated";
  }
  if (w.webhook_type === "ITEM" && RELINK_ITEM_CODES.has(w.webhook_code)) {
    await db
      .update(item)
      .set({ status: "relink_required", statusDetail: w.webhook_code })
      .where(eq(item.id, row.id));
    return "status_updated";
  }
  if (key === "ITEM:LOGIN_REPAIRED") {
    await db.update(item).set({ status: "active", statusDetail: null }).where(eq(item.id, row.id));
  }
  if (SYNC_TRIGGERS.has(key)) {
    requestSync(row.id);
    return "sync_requested";
  }
  return "ignored";
}
