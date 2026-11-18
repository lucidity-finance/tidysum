import { describe, expect, it } from "vitest";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { FakePlaid } from "./fakePlaid.js";
import { NOW, webhookSigner } from "./webhookSigner.js";

function setup() {
  const plaid = new FakePlaid();
  const signer = webhookSigner();
  plaid.webhookKeys.set(signer.kid, signer.key);
  return { verifier: new PlaidWebhookVerifier(plaid, () => NOW), signer };
}

const body = JSON.stringify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "x" });

describe("PlaidWebhookVerifier", () => {
  it("accepts a correctly signed, fresh webhook", async () => {
    const { verifier, signer } = setup();
    await expect(verifier.verify(signer.signJwt(body), body)).resolves.toBeUndefined();
  });

  it("rejects a missing header", async () => {
    const { verifier } = setup();
    await expect(verifier.verify(undefined, body)).rejects.toThrow(/missing/);
  });

  it("rejects a body that does not match the signed hash", async () => {
    const { verifier, signer } = setup();
    const jwt = signer.signJwt(body);
    await expect(verifier.verify(jwt, body.replace("ERROR", "LOGIN_REPAIRED"))).rejects.toThrow(
      /body hash/,
    );
  });

  it("rejects a webhook older than five minutes", async () => {
    const { verifier, signer } = setup();
    await expect(verifier.verify(signer.signJwt(body, { iat: NOW - 301 }), body)).rejects.toThrow(
      /too old/,
    );
  });

  it("rejects a token that names another algorithm", async () => {
    const { verifier, signer } = setup();
    await expect(verifier.verify(signer.signJwt(body, { alg: "none" }), body)).rejects.toThrow(
      /unexpected alg/,
    );
  });

  it("rejects a signature from a different key", async () => {
    const { verifier } = setup();
    const impostor = webhookSigner("kid-1"); // same kid, different private key
    await expect(verifier.verify(impostor.signJwt(body), body)).rejects.toThrow(/bad signature/);
  });
});
