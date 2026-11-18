import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";

describe("TokenCipher", () => {
  const cipher = new TokenCipher(randomBytes(32).toString("base64"));

  it("round-trips a token", () => {
    const blob = cipher.encrypt("access-sandbox-123", "item-a");
    expect(blob.toString("utf8")).not.toContain("access-sandbox");
    expect(cipher.decrypt(blob, "item-a")).toBe("access-sandbox-123");
  });

  it("refuses a ciphertext moved to another item", () => {
    const blob = cipher.encrypt("access-sandbox-123", "item-a");
    expect(() => cipher.decrypt(blob, "item-b")).toThrow();
  });

  it("refuses a wrong key", () => {
    const blob = cipher.encrypt("access-sandbox-123", "item-a");
    const other = new TokenCipher(randomBytes(32).toString("base64"));
    expect(() => other.decrypt(blob, "item-a")).toThrow();
  });
});
