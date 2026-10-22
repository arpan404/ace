import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer as createTlsServer } from "node:tls";
import { afterEach, expect, test } from "vitest";
import { PairingResponse } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { accessRequest, pinnedAgent } from "./client-access.ts";
import { readConfig } from "./config.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { fixture, token } from "./socket-test-support.ts";
import { loadIdentity, publicKeyFingerprint } from "./tls-identity.ts";

const tailnet = "studio.tail1234.ts.net";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });

/** A stand-in for Let's Encrypt: a CA, and leaves it signs for the given DNS names. */
async function authority() {
  const directory = await mkdtemp(join(tmpdir(), "ace-tailnet-ca-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...ec,
    "-keyout",
    join(directory, "ca.key"),
    "-out",
    join(directory, "ca.pem"),
    "-subj",
    "/CN=Test tailnet CA",
    "-days",
    "2",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  );
  let serial = 0;
  return {
    root: await readFile(join(directory, "ca.pem"), "utf8"),
    async leaf(name: string) {
      const base = join(directory, `leaf-${++serial}`);
      await writeFile(`${base}.ext`, `subjectAltName=DNS:${name}\nextendedKeyUsage=serverAuth\n`);
      openssl(
        "req",
        ...ec,
        "-keyout",
        `${base}.key`,
        "-out",
        `${base}.csr`,
        "-subj",
        `/CN=${name}`,
      );
      openssl(
        "x509",
        "-req",
        "-in",
        `${base}.csr`,
        "-CA",
        join(directory, "ca.pem"),
        "-CAkey",
        join(directory, "ca.key"),
        "-set_serial",
        String(serial),
        "-days",
        "2",
        "-extfile",
        `${base}.ext`,
        "-out",
        `${base}.pem`,
      );
      return {
        cert: await readFile(`${base}.pem`, "utf8"),
        key: await readFile(`${base}.key`, "utf8"),
      };
    },
  };
}

/** The certificate a TLS client is shown when it asks for `servername`. */
async function presented(port: number, servername?: string): Promise<string> {
  const socket = connect({
    host: "127.0.0.1",
    port,
    rejectUnauthorized: false,
    ...(servername ? { servername } : {}),
  });
  await once(socket, "secureConnect");
  const raw = socket.getPeerCertificate().raw;
  socket.destroy();
  return publicKeyFingerprint(raw);
}

/** A GET through ace's pinned agent, sent to 127.0.0.1 while naming `servername`. */
function pinnedGet(
  port: number,
  servername: string,
  fingerprint: string,
  roots: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        host: "127.0.0.1",
        port,
        servername,
        path: "/",
        agent: pinnedAgent(fingerprint, Date.now, roots),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
  });
}

/** A plain TLS server answering every request with 204. */
async function serve(certificate: { cert: string; key: string }): Promise<number> {
  const server = createTlsServer(certificate, (socket) => {
    socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no port");
  return address.port;
}

test("over Tailscale, a pairing link names the ts.net host and browsers asking for it get Tailscale's certificate", async () => {
  const ca = await authority();
  const leaf = await ca.leaf(tailnet);
  const home = await mkdtemp(join(tmpdir(), "ace-tailnet-https-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir: home });
  cleanups.push(() => settings.close());
  await settings.set("remote.enabled", true, { kind: "global" });
  await settings.set("remote.transport", "tailscale", { kind: "global" });
  const identity = loadIdentity(tlsFixtureHome());
  const f = await fixture({
    settings,
    remoteConfig: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    network: {
      identity: () => identity,
      interfaces: () => ({}),
      status: async () =>
        JSON.stringify({
          BackendState: "Running",
          TailscaleIPs: ["127.0.0.1"],
          Self: { DNSName: `${tailnet}.` },
          CurrentTailnet: { MagicDNSEnabled: true },
        }),
      // `tailscale cert --cert-file - --key-file -` prints the chain, then the key.
      certificate: async (name) => {
        if (name !== tailnet) throw new Error(`unexpected certificate request for ${name}`);
        return `${leaf.cert}${ca.root}${leaf.key}`;
      },
    },
  });
  cleanups.push(() => f.close());

  const pairing = PairingResponse.parse(
    await accessRequest(f.server.httpUrl, "/v1/pairings", { token, method: "POST", body: {} }),
  );
  const link = new URL(pairing.url);
  expect(link.hostname).toBe(tailnet);
  expect(new URLSearchParams(link.hash.slice(1)).get("fingerprint")).toBe(identity.fingerprint);
  const port = Number(link.port);

  const tailscaleKey = publicKeyFingerprint(leaf.cert);
  await expect.poll(() => presented(port, tailnet), { timeout: 5000 }).toBe(tailscaleKey);
  // Clients that reach the 100.x address, or name nothing, keep ace's own pinned certificate.
  expect(await presented(port)).toBe(identity.fingerprint);
  expect(await presented(port, "other.tail1234.ts.net")).toBe(identity.fingerprint);
  // A paired native client still holds ace's pin and connects to the ts.net name.
  expect(await pinnedGet(port, tailnet, identity.fingerprint, [ca.root])).toBeGreaterThan(0);
});

test("the pin gives way only to a trusted certificate for the exact ts.net name asked for", async () => {
  const ca = await authority();
  const pin = "0".repeat(64);

  const tailnetPort = await serve(await ca.leaf(tailnet));
  expect(await pinnedGet(tailnetPort, tailnet, pin, [ca.root])).toBe(204);
  // Trusted roots, but a different name than the certificate's.
  await expect(pinnedGet(tailnetPort, "other.tail1234.ts.net", pin, [ca.root])).rejects.toThrow(
    /fingerprint mismatch/,
  );
  // The right name, but signed by no authority this client trusts.
  const untrusted = await authority();
  await expect(pinnedGet(tailnetPort, tailnet, pin, [untrusted.root])).rejects.toThrow(
    /fingerprint mismatch/,
  );
  // A trusted certificate for a name outside ts.net never replaces the pin.
  const elsewhere = "studio.example.com";
  const elsewherePort = await serve(await ca.leaf(elsewhere));
  await expect(pinnedGet(elsewherePort, elsewhere, pin, [ca.root])).rejects.toThrow(
    /fingerprint mismatch/,
  );
});
