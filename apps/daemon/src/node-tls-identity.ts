import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selfSignedCertificate } from "./self-signed-certificate.ts";

/**
 * Windows ships no OpenSSL. When `<home>/tls` doesn't exist yet, writes the identity
 * `loadIdentity` would have asked OpenSSL for (RSA 2048, SHA-256, ten years, `CN=ace`), made with
 * node:crypto, the same way: in a temporary folder renamed into place, so a concurrent start
 * sees either nothing or the whole identity. `loadIdentity` then reads it as usual.
 */
export async function ensureIdentity(home: string, now: () => Date = () => new Date()) {
  const directory = join(home, "tls");
  if (existsSync(directory)) return;
  const temporary = join(home, `tls-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const { key, cert } = selfSignedCertificate({ commonName: "ace", days: 3650, now: now() });
    await writeFile(join(temporary, "key.pem"), key, { mode: 0o600 });
    await writeFile(join(temporary, "cert.pem"), cert);
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    // Another start won the rename; its identity is the one to use.
    if (!existsSync(directory)) throw error;
  }
}
