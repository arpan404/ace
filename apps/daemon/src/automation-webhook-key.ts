import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webhookSecretBox, type SecretBox } from "@ace/automations";

/** The key file, beside the stores and never inside them (ADR 0158, decision 11). */
export const webhookKeyName = "automation-webhooks.key";

/**
 * The box both automation stores seal webhook secrets with. Its key is 32 random bytes in an
 * owner-only file, made the first time a secret is sealed or opened; until then nothing is
 * written. A key file of the wrong size is refused rather than replaced, since replacing it would
 * silently make every stored secret unreadable.
 */
export function webhookSecrets(dataDir: string): SecretBox {
  const path = join(dataDir, webhookKeyName);
  const read = () => {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error(`${webhookKeyName} isn't a 32-byte key`);
    return new Uint8Array(key);
  };
  return webhookSecretBox(() => {
    try {
      return read();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (error) {
      // The other store made it first.
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return read();
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
