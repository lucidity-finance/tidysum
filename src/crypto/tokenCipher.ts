import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for Plaid access tokens at rest. The item id is bound as associated data,
 * so a ciphertext copied onto another item's row fails to decrypt.
 * Layout: iv (12 bytes) | auth tag (16 bytes) | ciphertext.
 */
export class TokenCipher {
  static readonly keyVersion = 1;
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("token key must be 32 bytes");
  }

  encrypt(plaintext: string, itemId: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(itemId));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, itemId: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(itemId));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
  }
}
