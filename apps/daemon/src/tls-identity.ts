import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const publicKeyFingerprint = (cert: string | Buffer): string =>
  createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
export interface TlsIdentity {
  key: Buffer;
  cert: Buffer;
  fingerprint: string;
}
/** OpenSSL is used only to sign a locally generated TLS identity, never for provider auth. */
export function loadIdentity(home: string): TlsIdentity {
  const directory = join(home, "tls");
  if (!existsSync(directory)) {
    const temporary = join(home, `tls-${process.pid}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "3650",
          "-subj",
          "/CN=ace",
          "-keyout",
          join(temporary, "key.pem"),
          "-out",
          join(temporary, "cert.pem"),
        ],
        { stdio: "ignore" },
      );
      chmodSync(join(temporary, "key.pem"), 0o600);
      renameSync(temporary, directory);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw new Error("Cannot generate TLS identity. Install OpenSSL and retry.", { cause: error });
    }
  }
  const key = readFileSync(join(directory, "key.pem"));
  chmodSync(join(directory, "key.pem"), 0o600);
  const cert = readFileSync(join(directory, "cert.pem"));
  return { key, cert, fingerprint: publicKeyFingerprint(cert) };
}
