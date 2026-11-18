import { createHash, generateKeyPairSync, sign } from "node:crypto";

export const NOW = 1_800_000_000;

/** Signs webhooks the way Plaid does, with a fresh P-256 key. */
export function webhookSigner(kid = "kid-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  const key = { jwk: { ...jwk, kid, alg: "ES256" }, expiredAt: null };
  const signJwt = (body: string, opts: { iat?: number; alg?: string; bodyHash?: string } = {}) => {
    const header = Buffer.from(
      JSON.stringify({ alg: opts.alg ?? "ES256", kid, typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iat: opts.iat ?? NOW,
        request_body_sha256: opts.bodyHash ?? createHash("sha256").update(body).digest("hex"),
      }),
    ).toString("base64url");
    const sig = sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${payload}.${sig.toString("base64url")}`;
  };
  return { kid, key, signJwt };
}
