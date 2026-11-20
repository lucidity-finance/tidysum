import { and, eq, inArray } from "drizzle-orm";
import type { TokenCipher } from "../crypto/tokenCipher.js";
import type { Db } from "../db/client.js";
import { item } from "../db/schema.js";
import type { PlaidGateway } from "../plaid/gateway.js";
import { type SyncResult, syncItem } from "./syncItem.js";

/**
 * Serializes syncs per Item. Webhooks, the interval timer and the Link page can all ask for a
 * sync at once; an Item never syncs twice concurrently, and a request that arrives mid-sync
 * runs once more afterwards so no update is missed.
 */
export class SyncScheduler {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly plaid: PlaidGateway,
    private readonly cipher: TokenCipher,
    private readonly onResult: (r: SyncResult) => void = () => {},
  ) {}

  request(itemId: string): Promise<void> {
    const current = this.running.get(itemId);
    if (current) {
      this.again.add(itemId);
      return current;
    }
    const run = (async () => {
      do {
        this.again.delete(itemId);
        try {
          this.onResult(await syncItem(this.db, this.plaid, this.cipher, itemId));
        } catch (err) {
          // syncItem records Plaid failures itself; this is the database being unreachable.
          console.error(`sync of item ${itemId} crashed:`, err);
        }
      } while (this.again.has(itemId));
    })().finally(() => this.running.delete(itemId));
    this.running.set(itemId, run);
    return run;
  }

  async syncAll(): Promise<void> {
    const items = await this.db
      .select({ id: item.id })
      .from(item)
      .where(and(eq(item.source, "plaid"), inArray(item.status, ["active", "error"])));
    await Promise.all(items.map((i) => this.request(i.id)));
  }

  /**
   * Try again the Items whose last sync failed on Plaid's or the bank's side. Items that need
   * the owner to reconnect are left alone: retrying can't fix them.
   */
  async retryFailed(): Promise<number> {
    const items = await this.db
      .select({ id: item.id })
      .from(item)
      .where(and(eq(item.source, "plaid"), eq(item.status, "error")));
    await Promise.all(items.map((i) => this.request(i.id)));
    return items.length;
  }

  /** Wait for every sync in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }
}
