/*
 * Webhook secrets at rest (ADR 0158, decision 11): AES-256-GCM under a key kept outside the
 * store, so a copy of `automations.sqlite` (a backup, a support bundle, a copied home) holds no
 * usable secret. Each secret is bound to its automation's id, so rows can't be swapped.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretBox {
  seal(secret: string, automationId: string): string;
  /** The secret, or undefined when it was sealed under another key or for another automation. */
  open(sealed: string, automationId: string): string | undefined;
}

const version = "v1";

/** A box over a 32-byte key, read the first time a secret is sealed or opened. */
export function webhookSecretBox(key: () => Uint8Array): SecretBox {
  let cached: Uint8Array | undefined;
  const current = () => (cached ??= key());
  return {
    seal(secret, automationId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", current(), iv);
      cipher.setAAD(Buffer.from(automationId));
      const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return [version, iv, cipher.getAuthTag(), sealed]
        .map((part) => (typeof part === "string" ? part : part.toString("base64")))
        .join(".");
    },
    open(sealed, automationId) {
      const [tag, iv, auth, data] = sealed.split(".");
      if (tag !== version || !iv || !auth || !data) return undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", current(), Buffer.from(iv, "base64"));
        decipher.setAAD(Buffer.from(automationId));
        decipher.setAuthTag(Buffer.from(auth, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(data, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}
