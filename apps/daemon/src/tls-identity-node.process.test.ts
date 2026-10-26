import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:https";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { expect, it, onTestFinished } from "vitest";
import { pinnedAgent } from "./client-access.ts";
import { loadIdentity } from "./tls-identity.ts";

function fetchStatus(port: number, fingerprint: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/", agent: pinnedAgent(fingerprint) }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).once("error", reject);
  });
}

it.runIf(process.platform === "win32")(
  "on Windows, ace makes its pinned TLS identity without OpenSSL, keeps it, and clients pin it",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-tls-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const path = process.env.PATH;
    // No OpenSSL to find: the runner's Git ships one, and Windows itself doesn't.
    process.env.PATH = "";
    let identity;
    try {
      identity = loadIdentity(home);
    } finally {
      process.env.PATH = path;
    }
    const certificate = new X509Certificate(identity.cert);
    expect(certificate.subject).toBe("CN=ace");
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)).toBe(
      3650 * 86_400_000,
    );
    expect(loadIdentity(home).fingerprint).toBe(identity.fingerprint);

    const server = createServer({ key: identity.key, cert: identity.cert }, (_request, response) =>
      response.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    expect(await fetchStatus(port, identity.fingerprint)).toBe(200);
    await expect(fetchStatus(port, "0".repeat(64))).rejects.toThrow(/fingerprint mismatch/);
  },
);
