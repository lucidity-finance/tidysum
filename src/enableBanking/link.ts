import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TokenCipher } from "../crypto/tokenCipher.js";
import type { Db } from "../db/client.js";
import { item, itemSecret } from "../db/schema.js";
import type { Bank, BankListing, EnableBankingClient } from "./client.js";
import { ebToken } from "./gateway.js";

// Linking a UK or EU bank through Enable Banking: the page picks a bank, the person signs in at
// their bank, and the bank sends them back with a code that becomes a session. The state ties the
// return to the request that started it; it also carries the address of this Tidysum, so the
// project's https forwarding page (site/bank-callback.html) can send the person back to a Tidysum
// that only listens on 127.0.0.1.

/** How long a started link waits for the person to come back from their bank. */
const PENDING_MS = 30 * 60_000;
/** The longest consent asked for; most banks give 180 days. */
const MAX_CONSENT_DAYS = 180;

interface Pending {
  userId: string;
  bank: Bank;
  itemId: string | undefined;
  at: number;
}

/** Tidysum's own name for an Enable Banking bank, kept in item.institution_id. */
export const institutionIdOf = (bank: Bank) => `eb:${bank.country}:${bank.name}`;

export class BankLinks {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly client: EnableBankingClient,
    /** The registered redirect URL, or undefined for this Tidysum's own callback. */
    private readonly redirectUrl: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listBanks(country: string): Promise<BankListing[]> {
    return this.client.listBanks(country);
  }

  /**
   * The bank's sign-in page for a new link, or with `itemId` for renewing one whose consent ran
   * out. `origin` is this Tidysum's address as the browser sees it.
   */
  async start(p: { userId: string; bank: Bank; itemId?: string; origin: string }) {
    const listed = (await this.client.listBanks(p.bank.country)).find(
      (b) => b.name === p.bank.name,
    );
    if (!listed) throw new Error(`Enable Banking doesn't list ${p.bank.name} in ${p.bank.country}`);
    const at = this.now().getTime();
    for (const [k, v] of this.pending) if (at - v.at > PENDING_MS) this.pending.delete(k);
    const nonce = randomBytes(18).toString("base64url");
    this.pending.set(nonce, { userId: p.userId, bank: p.bank, itemId: p.itemId, at });
    const days = Math.min(
      MAX_CONSENT_DAYS,
      Math.floor((listed.maximum_consent_validity ?? MAX_CONSENT_DAYS * 86_400) / 86_400),
    );
    const callback = new URL("/enable-banking/callback", p.origin).toString();
    return this.client.startAuth({
      bank: p.bank,
      state: `${nonce}.${Buffer.from(p.origin).toString("base64url")}`,
      redirectUrl: this.redirectUrl ?? callback,
      // A minute short of the limit, so the clock between here and the bank can't overshoot it.
      validUntil: new Date(at + days * 86_400_000 - 60_000),
    });
  }

  /**
   * Turns the bank's code into a stored connection: a new item, or the same item renewed. Returns
   * the item id. The person must come back to the same user that started the link.
   */
  async finish(db: Db, cipher: TokenCipher, userId: string, state: string, code: string) {
    const nonce = state.split(".")[0] ?? "";
    const pending = this.pending.get(nonce);
    if (!pending || pending.userId !== userId) {
      throw new Error("This bank sign-in wasn't started here, or took too long. Start it again.");
    }
    this.pending.delete(nonce);
    const session = await this.client.createSession(code);
    if (session.accounts.length === 0) {
      await this.client.deleteSession(session.session_id).catch(() => {});
      throw new Error(
        `${pending.bank.name} shared no accounts. In Enable Banking's free mode, only accounts ` +
          "linked in its Control Panel come through: link them there first (Activate by linking " +
          "accounts), then try again.",
      );
    }
    const bank = session.aspsp ?? pending.bank;
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: item.id })
        .from(item)
        .where(
          and(
            eq(item.userId, userId),
            eq(item.source, "enable_banking"),
            pending.itemId
              ? eq(item.id, pending.itemId)
              : eq(item.institutionId, institutionIdOf(bank)),
          ),
        );
      const [row] = existing
        ? await tx
            .update(item)
            .set({ status: "active", statusDetail: null })
            .where(eq(item.id, existing.id))
            .returning({ id: item.id })
        : await tx
            .insert(item)
            .values({
              userId,
              source: "enable_banking",
              institutionId: institutionIdOf(bank),
              institutionName: bank.name,
            })
            .returning({ id: item.id });
      if (!row) throw new Error("item insert returned no row");
      const ciphertext = cipher.encrypt(ebToken(session.session_id, row.id), row.id);
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
}
