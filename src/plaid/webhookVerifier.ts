import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { PlaidGateway, WebhookVerificationKey } from "./gateway.js";

const MAX_AGE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

/**
 * Verifies the `Plaid-Verification` header: an ES256 JWT whose payload carries the SHA-256 of
 * the raw request body. Follows https://plaid.com/docs/api/webhooks/webhook-verification/.
 */
export class PlaidWebhookVerifier {
  private readonly keys = new Map<string, WebhookVerificationKey>();

  constructor(
    private readonly plaid: PlaidGateway,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async verify(jwt: string | undefined, rawBody: string): Promise<void> {
    if (!jwt) throw new WebhookVerificationError("missing Plaid-Verification header");
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new WebhookVerificationError("malformed JWT");
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = parseJson(headerB64) as { alg?: string; kid?: string };
    // Pin the algorithm: never let the token choose it.
    if (header.alg !== "ES256") throw new WebhookVerificationError(`unexpected alg ${header.alg}`);
    if (!header.kid) throw new WebhookVerificationError("missing kid");

    const key = await this.key(header.kid);
    if (key.expiredAt !== null && key.expiredAt <= this.nowSeconds()) {
      throw new WebhookVerificationError("verification key has expired");
    }
    const publicKey = createPublicKey({ key: key.jwk, format: "jwk" });
    const signed = Buffer.from(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(signatureB64, "base64url");
    const ok = verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    if (!ok) throw new WebhookVerificationError("bad signature");

    const payload = parseJson(payloadB64) as { iat?: number; request_body_sha256?: string };
    if (typeof payload.iat !== "number" || this.nowSeconds() - payload.iat > MAX_AGE_SECONDS) {
      throw new WebhookVerificationError("webhook is too old");
    }
    const expected = Buffer.from(payload.request_body_sha256 ?? "", "hex");
    const actual = createHash("sha256").update(rawBody).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new WebhookVerificationError("body hash mismatch");
    }
  }

  private async key(kid: string): Promise<WebhookVerificationKey> {
    const cached = this.keys.get(kid);
    if (cached && cached.expiredAt === null) return cached;
    const fresh = await this.plaid.getWebhookVerificationKey(kid);
    this.keys.set(kid, fresh);
    return fresh;
  }
}

function parseJson(b64url: string): unknown {
  try {
    return JSON.parse(Buffer.from(b64url, "base64url").toString("utf8"));
  } catch {
    throw new WebhookVerificationError("malformed JWT");
  }
}
