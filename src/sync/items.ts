import { eq, sql } from "drizzle-orm";
import { TokenCipher } from "../crypto/tokenCipher.js";
import type { Db } from "../db/client.js";
import { appUser, item, itemSecret } from "../db/schema.js";
import type { PlaidGateway } from "../plaid/gateway.js";

/** Exchange a Link public token and store the user's Item with its access token encrypted. */
export async function linkItem(
  db: Db,
  plaid: PlaidGateway,
  cipher: TokenCipher,
  userId: string,
  publicToken: string,
): Promise<string> {
  const { accessToken, itemId: plaidItemId } = await plaid.exchangePublicToken(publicToken);
  const info = await plaid.getItem(accessToken);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(item)
      .values({
        userId,
        source: "plaid",
        plaidItemId,
        institutionId: info.institutionId,
        institutionName: info.institutionName,
      })
      .onConflictDoUpdate({
        target: item.plaidItemId,
        set: { status: "active", statusDetail: null },
        // Re-linking an Item only ever refreshes the same user's row.
        setWhere: sql`${item.userId} = ${userId}`,
      })
      .returning({ id: item.id });
    if (!row) throw new Error("this Plaid Item belongs to another user");

    const ciphertext = cipher.encrypt(accessToken, row.id);
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
}

export async function loadAccessToken(db: Db, cipher: TokenCipher, itemId: string) {
  const [secret] = await db.select().from(itemSecret).where(eq(itemSecret.itemId, itemId));
  if (!secret) throw new Error(`no access token stored for item ${itemId}`);
  return cipher.decrypt(secret.accessTokenCiphertext, itemId);
}

/**
 * Plaid's user id for this person, registering them with Plaid the first time. Undefined when
 * Plaid refuses (an account without the user APIs): Link then adds one institution per session.
 */
export async function ensurePlaidUser(
  db: Db,
  plaid: PlaidGateway,
  userId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ plaidUserId: appUser.plaidUserId })
    .from(appUser)
    .where(eq(appUser.id, userId));
  if (!row) throw new Error(`unknown user ${userId}`);
  if (row.plaidUserId) return row.plaidUserId;
  try {
    const plaidUserId = await plaid.createUser(userId);
    await db.update(appUser).set({ plaidUserId }).where(eq(appUser.id, userId));
    return plaidUserId;
  } catch (err) {
    console.warn(`Plaid /user/create failed, linking one institution at a time: ${String(err)}`);
    return undefined;
  }
}
