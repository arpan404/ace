import { execFileSync } from "node:child_process";
import { createHash, X509Certificate, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { selfSignedCertificate } from "./self-signed-certificate.ts";

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
export interface IdentityRuntime {
  id(): string;
  sign(command: string, args: string[]): void;
}
export const systemIdentity: Readonly<IdentityRuntime> = {
  id: randomUUID,
  sign: (command, args) => {
    execFileSync(command, args, { stdio: "ignore" });
  },
};
// Windows ships no OpenSSL: the same identity is made with node:crypto instead.
if (process.platform === "win32") Object.assign(systemIdentity, { sign: signWithoutOpenssl });

/** Writes the key and certificate the `openssl req -x509` call below asks for. */
function signWithoutOpenssl(_command: string, args: string[]): void {
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  const keyout = after("-keyout");
  const out = after("-out");
  if (!keyout || !out) throw new Error("No output files for the TLS identity");
  const { key, cert } = selfSignedCertificate({
    commonName: "ace",
    days: Number(after("-days")) > 0 ? Number(after("-days")) : 3650,
    now: new Date(),
  });
  writeFileSync(keyout, key, { mode: 0o600 });
  writeFileSync(out, cert);
}
export function loadIdentity(home: string, runtime: IdentityRuntime = systemIdentity): TlsIdentity {
  const directory = join(home, "tls");
  if (!existsSync(directory)) {
    const temporary = join(home, `tls-${runtime.id()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      runtime.sign("openssl", [
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
      ]);
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
