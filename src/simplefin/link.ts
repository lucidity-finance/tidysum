import { and, eq } from "drizzle-orm";
import { TokenCipher } from "../crypto/tokenCipher.js";
import type { Db } from "../db/client.js";
import { item, itemSecret } from "../db/schema.js";
import { loadAccessToken } from "../sync/items.js";
import type { SimpleFinClient } from "./client.js";
import { connectionsOf, isSfToken, parseSfToken, sfToken } from "./gateway.js";

// Linking through SimpleFIN Bridge (decision 0013): the person connects their banks at the
// Bridge, makes a setup token for Tidysum there and pastes it on the Connections page. Tidysum
// claims it for an access URL and makes one item per bank the Bridge shares. Pasting a new token
// later renews the banks already here (same connection id) and adds any new ones. Without a
// token, the stored access URL is asked again, for banks added at the Bridge since.

export interface LinkedBank {
  itemId: string;
  name: string;
  /** False when the bank was already here and only renewed. */
  added: boolean;
}

/** Tidysum's own name for a SimpleFIN institution, kept in item.institution_id. */
export const institutionIdOf = (orgId: string) => `sf:${orgId}`;

/** The user's SimpleFIN items and the connection each one reads. */
async function simplefinItems(db: Db, cipher: TokenCipher, userId: string) {
  const rows = await db
    .select({ id: item.id })
    .from(item)
    .where(and(eq(item.userId, userId), eq(item.source, "simplefin")));
  const out: { itemId: string; accessUrl: string; connId: string }[] = [];
  for (const r of rows) {
    const token = await loadAccessToken(db, cipher, r.id).catch(() => null);
    if (!token || !isSfToken(token)) continue;
    const t = parseSfToken(token);
    out.push({ itemId: r.id, accessUrl: t.sf, connId: t.c });
  }
  return out;
}

/** True when the user has a SimpleFIN access URL Tidysum can ask again. */
export async function hasSimpleFin(db: Db, cipher: TokenCipher, userId: string) {
  return (await simplefinItems(db, cipher, userId)).length > 0;
}

export async function linkSimpleFin(
  db: Db,
  cipher: TokenCipher,
  client: SimpleFinClient,
  userId: string,
  setupToken?: string,
): Promise<LinkedBank[]> {
  const existing = await simplefinItems(db, cipher, userId);
  let accessUrl: string;
  if (setupToken) {
    accessUrl = await client.claim(setupToken);
  } else {
    const last = existing.at(-1);
    if (!last) throw new Error("Paste a setup token from SimpleFIN Bridge first.");
    accessUrl = last.accessUrl;
  }
  const set = await client.accounts(accessUrl, { balancesOnly: true, fresh: true });
  const banks = connectionsOf(set);
  if (banks.length === 0) {
    throw new Error(
      "SimpleFIN shares no banks with this token yet. Connect your banks at SimpleFIN Bridge, " +
        "then try again.",
    );
  }
  const linked: LinkedBank[] = [];
  for (const bank of banks) {
    const known = existing.find((e) => e.connId === bank.connId);
    // Asking the stored access URL again only adds banks; it doesn't touch the ones here.
    if (known && !setupToken) continue;
    const itemId = await db.transaction(async (tx) => {
      const [row] = known
        ? await tx
            .update(item)
            .set({ status: "active", statusDetail: null })
            .where(eq(item.id, known.itemId))
            .returning({ id: item.id })
        : await tx
            .insert(item)
            .values({
              userId,
              source: "simplefin",
              institutionId: institutionIdOf(bank.orgId),
              institutionName: bank.name,
            })
            .returning({ id: item.id });
      if (!row) throw new Error("item insert returned no row");
      const ciphertext = cipher.encrypt(sfToken(accessUrl, bank.connId, row.id), row.id);
      await tx
        .insert(itemSecret)
        .values({
          itemId: row.id,
          accessTokenCiphertext: ciphertext,
          keyVersion: TokenCipher.keyVersion,
        })
        .onConflictDoUpdate({
          target: itemSecret.itemId,
          set: { accessTokenCiphertext: ciphertext, keyVersion: TokenCipher.keyVersion },
        });
      return row.id;
    });
    linked.push({ itemId, name: bank.name, added: !known });
  }
  return linked;
}
